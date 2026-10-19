import { describe, it, expect, beforeEach } from 'vitest'
import { SubtaskEventBus } from './subtask-events'

let bus: SubtaskEventBus

beforeEach(() => {
  bus = new SubtaskEventBus()
})

describe('SubtaskEventBus', () => {
  it('assigns monotonically increasing sequence numbers', () => {
    const a = bus.emitSubtaskEvent({ kind: 'status', parentTaskId: 'p', childTaskId: 'c1', status: 'ready_for_review' })
    const b = bus.emitSubtaskEvent({ kind: 'status', parentTaskId: 'p', childTaskId: 'c2', status: 'ready_for_review' })
    expect(b.seq).toBeGreaterThan(a.seq)
  })

  it('waitFor resolves immediately from the buffer when a matching event was already emitted before subscribing (no missed-event race)', async () => {
    const sinceSeq = bus.currentSeq()
    bus.emitSubtaskEvent({ kind: 'status', parentTaskId: 'p', childTaskId: 'c1', status: 'ready_for_review' })

    // Simulates: caller read DB state (saw nothing done), THEN subscribes —
    // but the event already landed in the gap. sinceSeq from before the read
    // means it's still found, not missed.
    const found = await bus.waitFor((e) => e.childTaskId === 'c1', { sinceSeq, timeoutMs: 1000 })
    expect(found?.status).toBe('ready_for_review')
  })

  it('waitFor resolves live when a matching event arrives after subscribing', async () => {
    const sinceSeq = bus.currentSeq()
    const promise = bus.waitFor((e) => e.childTaskId === 'c1', { sinceSeq, timeoutMs: 1000 })
    setTimeout(() => bus.emitSubtaskEvent({ kind: 'status', parentTaskId: 'p', childTaskId: 'c1', status: 'completed' }), 5)
    const found = await promise
    expect(found?.status).toBe('completed')
  })

  it('waitFor ignores non-matching events and keeps waiting for the right one', async () => {
    const sinceSeq = bus.currentSeq()
    const promise = bus.waitFor((e) => e.childTaskId === 'c2', { sinceSeq, timeoutMs: 1000 })
    bus.emitSubtaskEvent({ kind: 'status', parentTaskId: 'p', childTaskId: 'c1', status: 'completed' })
    setTimeout(() => bus.emitSubtaskEvent({ kind: 'status', parentTaskId: 'p', childTaskId: 'c2', status: 'completed' }), 5)
    const found = await promise
    expect(found?.childTaskId).toBe('c2')
  })

  it('waitFor resolves with null on timeout, and leaves no listener behind', async () => {
    const sinceSeq = bus.currentSeq()
    const found = await bus.waitFor(() => false, { sinceSeq, timeoutMs: 20 })
    expect(found).toBeNull()
    expect(bus.listenerCount('event')).toBe(0)
  })

  it('waitFor resolves with null and cleans up when the abort signal fires', async () => {
    const controller = new AbortController()
    const sinceSeq = bus.currentSeq()
    const promise = bus.waitFor(() => false, { sinceSeq, timeoutMs: 5000, signal: controller.signal })
    controller.abort()
    const found = await promise
    expect(found).toBeNull()
    expect(bus.listenerCount('event')).toBe(0)
  })

  it('does not miss an event that lands between reading sinceSeq and subscribing, across many events', () => {
    const sinceSeq = bus.currentSeq()
    for (let i = 0; i < 10; i++) {
      bus.emitSubtaskEvent({ kind: 'status', parentTaskId: 'p', childTaskId: `c${i}`, status: 'completed' })
    }
    const replay = bus.eventsSince(sinceSeq)
    expect(replay).toHaveLength(10)
    expect(replay[0].childTaskId).toBe('c0')
  })
})
