import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import {
  TaskWakeupStore,
  TaskWakeupQueue,
  computeWakeupDeliveryId,
  type ParentDeliveryContext,
  type SubtaskSnapshot
} from './task-wakeups'

let now = Date.UTC(2026, 9, 19, 12, 0, 0)
let store: TaskWakeupStore
let ctx: ParentDeliveryContext
let send: ReturnType<typeof vi.fn<(parentTaskId: string, message: string) => Promise<void>>>
let queue: TaskWakeupQueue

function makeContext(overrides: Partial<ParentDeliveryContext> = {}): ParentDeliveryContext {
  return { exists: true, completed: false, sessionBusy: false, subtasks: [], ...overrides }
}

function subtask(status: string, id = 'child-1', title = 'Child task'): SubtaskSnapshot {
  return { id, title, status }
}

beforeEach(() => {
  now = Date.UTC(2026, 9, 19, 12, 0, 0)
  store = new TaskWakeupStore(new Database(':memory:'))
  ctx = makeContext({ subtasks: [subtask('ready_for_review')] })
  send = vi.fn(async () => undefined)
  queue = new TaskWakeupQueue({
    store,
    getDeliveryContext: () => ctx,
    send,
    now: () => now
  })
})

describe('computeWakeupDeliveryId', () => {
  it('is stable for the same transition and different for a different one', () => {
    const a = computeWakeupDeliveryId('parent-1', 'child-1', '2026-10-19T00:00:00.000Z', 'child_ready')
    const b = computeWakeupDeliveryId('parent-1', 'child-1', '2026-10-19T00:00:00.000Z', 'child_ready')
    const c = computeWakeupDeliveryId('parent-1', 'child-1', '2026-10-19T00:00:01.000Z', 'child_ready')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('TaskWakeupStore', () => {
  it('enqueues once per delivery id — a duplicate transition is a no-op', () => {
    const deliveryId = computeWakeupDeliveryId('parent-1', 'child-1', '2026-10-19T00:00:00.000Z', 'child_ready')
    const input = { parentTaskId: 'parent-1', childTaskId: 'child-1', reason: 'child_ready' as const, deliveryId, payload: { childTitle: 'Child', childStatus: 'ready_for_review' } }
    const first = store.enqueue(input, now)
    const second = store.enqueue(input, now)
    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(store.listPending('parent-1')).toHaveLength(1)
  })
})

describe('TaskWakeupQueue', () => {
  it('delivers immediately when the parent is idle', async () => {
    const deliveryId = computeWakeupDeliveryId('parent-1', 'child-1', '2026-10-19T00:00:00.000Z', 'child_ready')
    await queue.enqueueAndTryDeliver({
      parentTaskId: 'parent-1',
      childTaskId: 'child-1',
      reason: 'child_ready',
      deliveryId,
      payload: { childTitle: 'Child', childStatus: 'ready_for_review' }
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe('parent-1')
    expect(store.listPending('parent-1')).toHaveLength(0)
  })

  it('defers delivery while the parent session is busy, then delivers once idle', async () => {
    ctx = makeContext({ sessionBusy: true, subtasks: [subtask('ready_for_review')] })
    const deliveryId = computeWakeupDeliveryId('parent-1', 'child-1', '2026-10-19T00:00:00.000Z', 'child_ready')
    await queue.enqueueAndTryDeliver({
      parentTaskId: 'parent-1',
      childTaskId: 'child-1',
      reason: 'child_ready',
      deliveryId,
      payload: { childTitle: 'Child', childStatus: 'ready_for_review' }
    })
    expect(send).not.toHaveBeenCalled()
    expect(store.listPending('parent-1')).toHaveLength(1)

    ctx = makeContext({ sessionBusy: false, subtasks: [subtask('ready_for_review')] })
    await queue.tryDeliver('parent-1')
    expect(send).toHaveBeenCalledTimes(1)
    expect(store.listPending('parent-1')).toHaveLength(0)
  })

  it('defers in wait-for-all mode while a sibling is still agent_working', async () => {
    ctx = makeContext({ subtasks: [subtask('ready_for_review', 'child-1'), subtask('agent_working', 'child-2')] })
    const deliveryId = computeWakeupDeliveryId('parent-1', 'child-1', '2026-10-19T00:00:00.000Z', 'child_ready')
    await queue.enqueueAndTryDeliver({
      parentTaskId: 'parent-1',
      childTaskId: 'child-1',
      reason: 'child_ready',
      deliveryId,
      payload: { childTitle: 'Child 1', childStatus: 'ready_for_review' }
    })
    expect(send).not.toHaveBeenCalled()

    ctx = makeContext({ subtasks: [subtask('ready_for_review', 'child-1'), subtask('ready_for_review', 'child-2')] })
    await queue.tryDeliver('parent-1')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('combines several pending children into one message', async () => {
    ctx = makeContext({ sessionBusy: true, subtasks: [subtask('ready_for_review', 'child-1'), subtask('ready_for_review', 'child-2')] })
    for (const childId of ['child-1', 'child-2']) {
      const deliveryId = computeWakeupDeliveryId('parent-1', childId, '2026-10-19T00:00:00.000Z', 'child_ready')
      await queue.enqueueAndTryDeliver({
        parentTaskId: 'parent-1',
        childTaskId: childId,
        reason: 'child_ready',
        deliveryId,
        payload: { childTitle: `Child ${childId}`, childStatus: 'ready_for_review' }
      })
    }
    expect(send).not.toHaveBeenCalled()

    ctx = makeContext({ sessionBusy: false, subtasks: [subtask('ready_for_review', 'child-1'), subtask('ready_for_review', 'child-2')] })
    await queue.tryDeliver('parent-1')
    expect(send).toHaveBeenCalledTimes(1)
    const message = send.mock.calls[0][1]
    expect(message).toContain('child-1')
    expect(message).toContain('child-2')
  })

  it('never delivers to a completed parent', async () => {
    ctx = makeContext({ completed: true })
    const deliveryId = computeWakeupDeliveryId('parent-1', 'child-1', '2026-10-19T00:00:00.000Z', 'child_ready')
    await queue.enqueueAndTryDeliver({
      parentTaskId: 'parent-1',
      childTaskId: 'child-1',
      reason: 'child_ready',
      deliveryId,
      payload: { childTitle: 'Child', childStatus: 'ready_for_review' }
    })
    expect(send).not.toHaveBeenCalled()
    await queue.tryDeliver('parent-1')
    expect(send).not.toHaveBeenCalled()
    expect(store.listPending('parent-1')).toHaveLength(1)
  })

  it('retries a failed send and records the error without dropping the wake-up', async () => {
    send.mockRejectedValueOnce(new Error('network down'))
    const deliveryId = computeWakeupDeliveryId('parent-1', 'child-1', '2026-10-19T00:00:00.000Z', 'child_ready')
    await queue.enqueueAndTryDeliver({
      parentTaskId: 'parent-1',
      childTaskId: 'child-1',
      reason: 'child_ready',
      deliveryId,
      payload: { childTitle: 'Child', childStatus: 'ready_for_review' }
    })
    expect(send).toHaveBeenCalledTimes(1)
    const pending = store.listPending('parent-1')
    expect(pending).toHaveLength(1)
    expect(pending[0].attempts).toBe(1)
    expect(pending[0].lastError).toContain('network down')

    await queue.tryDeliver('parent-1')
    expect(send).toHaveBeenCalledTimes(2)
    expect(store.listPending('parent-1')).toHaveLength(0)
  })

  it('a restart in the middle delivers every pending row on the first sweep', async () => {
    const deliveryId = computeWakeupDeliveryId('parent-1', 'child-1', '2026-10-19T00:00:00.000Z', 'child_ready')
    store.enqueue(
      { parentTaskId: 'parent-1', childTaskId: 'child-1', reason: 'child_ready', deliveryId, payload: { childTitle: 'Child', childStatus: 'ready_for_review' } },
      now
    )
    // Simulate a fresh process: a brand-new queue instance over the same store.
    const freshQueue = new TaskWakeupQueue({ store, getDeliveryContext: () => ctx, send, now: () => now })
    await freshQueue.sweep()
    expect(send).toHaveBeenCalledTimes(1)
    expect(store.listPending('parent-1')).toHaveLength(0)
    freshQueue.stop()
  })
})
