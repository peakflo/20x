/**
 * Sender side of the transcript delta stream, through the REAL AgentManager
 * write-through path and a real (in-memory) transcript store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentManager } from './agent-manager'
import { createTestDb } from '../../test/helpers/db-test-helper'
import type { TranscriptDeltaEvent, TranscriptPartLike } from '../shared/transcript-stream'
import { TranscriptStreamReceiver, type TranscriptSyncResult } from '../shared/transcript-stream'

vi.mock('./task-api-server', () => ({ getTaskApiPort: vi.fn(), waitForTaskApiServer: vi.fn() }))

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function setup() {
  const { db } = createTestDb()
  const task = db.createTask({ title: 'Streaming task' })!
  const mgr = new AgentManager(db)
  const windowEvents: Array<{ channel: string; payload: unknown }> = []
  const external: Array<{ channel: string; payload: unknown }> = []
  const wholeParts: Array<{ taskId: string; parts: TranscriptPartLike[] }> = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(mgr as any).mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel: string, payload: unknown) => windowEvents.push({ channel, payload }) }
  }
  mgr.addExternalListener((channel, payload) => external.push({ channel, payload }))
  mgr.addTranscriptPartsListener((taskId, parts) => wholeParts.push({ taskId, parts }))
  const stream = (content: string, id = 'answer'): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(mgr as any).sendToRenderer('agent:output-batch', {
      sessionId: 's1', taskId: task.id, messages: [{ id, role: 'assistant', content, partType: 'text', update: true }]
    })
  }
  const deltas = (): TranscriptDeltaEvent[] =>
    windowEvents.filter((e) => e.channel === 'transcript:changed').map((e) => e.payload as TranscriptDeltaEvent)
  return { db, task, mgr, windowEvents, external, wholeParts, stream, deltas }
}

describe('AgentManager transcript delta stream (sender)', () => {
  it('sends a growing part whole once, then only the appended text', async () => {
    const { task, stream, deltas, external, wholeParts } = setup()
    stream('Hello')
    await vi.advanceTimersByTimeAsync(200)
    stream('Hello world')
    await vi.advanceTimersByTimeAsync(200)

    const [first, second] = deltas()
    expect(first).toMatchObject({ taskId: task.id, seq: 1 })
    expect(first.ops[0]).toMatchObject({ op: 'put', part: { partId: 'answer', content: 'Hello' } })
    expect(second).toMatchObject({ taskId: task.id, seq: 2, epoch: first.epoch })
    expect(second.ops).toEqual([expect.objectContaining({ op: 'append', partId: 'answer', at: 5, text: ' world' })])

    // Mobile (external listeners) gets the identical numbered payload.
    expect(external.filter((e) => e.channel === 'transcript:changed').map((e) => e.payload)).toEqual(deltas())
    // In-process consumers that read whole parts (voice) still get them.
    expect(wholeParts.map((w) => w.parts.map((p) => p.content))).toEqual([['Hello'], ['Hello world']])
  })

  it('sends a rewritten part whole (patch of an earlier part)', async () => {
    const { stream, deltas } = setup()
    stream('first draft', 'a')
    stream('tail', 'b')
    await vi.advanceTimersByTimeAsync(200)
    stream('rewritten', 'a')
    await vi.advanceTimersByTimeAsync(200)
    expect(deltas()[1].ops).toEqual([expect.objectContaining({ op: 'put', part: expect.objectContaining({ partId: 'a', content: 'rewritten' }) })])
  })

  it('resync sends pending changes first, so its seq and content agree with the stream', async () => {
    const { task, mgr, stream, deltas } = setup()
    stream('one')
    await vi.advanceTimersByTimeAsync(200)
    stream('one two') // still queued (flush timer not fired)

    const sync = await mgr.getTranscriptSync(task.id, undefined, { backfill: false })
    expect(deltas()).toHaveLength(2) // the queued change went out before the read
    expect(sync).toMatchObject({ taskId: task.id, seq: 2, full: true, epoch: deltas()[0].epoch })
    expect(sync.parts.map((p) => p.content)).toEqual(['one two'])

    await vi.advanceTimersByTimeAsync(200)
    expect(deltas()).toHaveLength(2) // nothing re-sent by the timer

    const catchUp = await mgr.getTranscriptSync(task.id, sync.maxRev, { backfill: false })
    expect(catchUp).toMatchObject({ full: false, seq: 2, parts: [] })
  })

  it('a receiver following the real sender ends with the stored transcript, gaps included', async () => {
    const { db, task, mgr, stream, deltas } = setup()
    const local = new Map<string, TranscriptPartLike>()
    let rev = 0
    const receiver = new TranscriptStreamReceiver<TranscriptPartLike>({
      isTracked: () => true,
      getPart: (_t, id) => local.get(id),
      getRev: () => rev,
      commit: (_t, parts, maxRev) => { for (const p of parts) local.set(p.partId, p); rev = Math.max(rev, maxRev) },
      replace: (_t, parts, maxRev) => { local.clear(); for (const p of parts) local.set(p.partId, p); rev = maxRev; return true },
      fetchSync: (taskId, sinceRev) => mgr.getTranscriptSync(taskId, sinceRev, { backfill: false }) as Promise<TranscriptSyncResult<TranscriptPartLike>>
    })
    await receiver.resync(task.id, { full: true })

    let text = ''
    for (let i = 0; i < 30; i++) {
      text += `chunk ${i} `
      stream(text)
      if (i % 7 === 3) stream(`tool output ${i}`, `tool-${i}`)
      await vi.advanceTimersByTimeAsync(130)
      const latest = deltas()[deltas().length - 1]
      if (i % 9 !== 4) receiver.handle(latest) // drop a few events on the floor
      await vi.advanceTimersByTimeAsync(0)
    }
    await receiver.resync(task.id, { full: false })
    const stored = db.getTranscriptParts(task.id)
    expect([...local.values()].map((p) => [p.partId, p.content]).sort()).toEqual(stored.map((p) => [p.partId, p.content]).sort())
  })
})
