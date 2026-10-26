/**
 * Bytes pushed to the renderer window and to mobile clients while one agent
 * streams an answer.
 *
 * Replays a realistic stream through the REAL `sendToRenderer` path with a real
 * (in-memory) transcript store: one poll every 100 ms, each poll re-sends the
 * growing assistant text in full (as the adapters do with `update: true`) and
 * adds 100 bytes; every 10th poll adds a tool call with 2 KB of output (so the
 * stream also carries 2x the answer size in tool output). Runs
 * for a 20 KB answer (200 polls) and a 100 KB answer (1,000 polls).
 *
 * - Window bytes: `JSON.stringify(payload).length` per `webContents.send`, a
 *   proxy for the structured-clone/serialization work on both sides of IPC.
 *   `structuredClone` time of those payloads is reported as a CPU proxy for the
 *   IPC serialize + deserialize (Electron uses the same algorithm).
 * - Mobile WS bytes: every external-listener event is framed exactly like
 *   `broadcastToMobileClients` does (`JSON.stringify({ type, payload })`), per
 *   connected client. No real socket is in the loop.
 */
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentManager } from './agent-manager'
import { createTestDb } from '../../test/helpers/db-test-helper'

vi.mock('./task-api-server', () => ({ getTaskApiPort: vi.fn(), waitForTaskApiServer: vi.fn() }))

afterEach(() => { vi.useRealTimers() })

interface StreamStats {
  outputSends: number
  windowSends: number
  windowKB: number
  mobileFrames: number
  mobileKB: number
  cloneMs: number
}

async function streamAnswer(answerKB: number): Promise<StreamStats> {
  vi.useFakeTimers()
  const { db } = createTestDb()
  const task = db.createTask({ title: 'Streaming task' })!
  const mgr = new AgentManager(db)
  let windowBytes = 0
  let windowSends = 0
  let outputSends = 0
  let cloneMs = 0
  let mobileBytes = 0
  let mobileFrames = 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(mgr as any).mainWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        if (channel.startsWith('agent:output')) outputSends += 1
        if (channel !== 'transcript:changed') return
        windowBytes += JSON.stringify(payload ?? null).length
        windowSends += 1
        // node:perf_hooks is not replaced by fake timers.
        const t0 = performance.now()
        structuredClone(payload)
        cloneMs += performance.now() - t0
      }
    }
  }
  mgr.addExternalListener((channel, data) => {
    if (channel !== 'transcript:changed') return
    mobileBytes += JSON.stringify({ type: channel, payload: data }).length
    mobileFrames += 1
  })

  const polls = answerKB * 10
  let text = ''
  for (let poll = 0; poll < polls; poll++) {
    text += 'x'.repeat(100)
    const messages: Array<Record<string, unknown>> = [
      { id: 'answer', role: 'assistant', content: text, partType: 'text', update: poll > 0 }
    ]
    if (poll % 10 === 0) {
      messages.push({
        id: `tool-${poll}`, role: 'assistant', content: '', partType: 'tool',
        tool: { name: 'Bash', status: 'completed', input: JSON.stringify({ command: `ls ${poll}` }), output: 'o'.repeat(2000) }
      })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(mgr as any).sendToRenderer('agent:output-batch', { sessionId: 's1', taskId: task.id, messages })
    await vi.advanceTimersByTimeAsync(100)
  }
  await vi.advanceTimersByTimeAsync(1000)
  vi.useRealTimers()
  return {
    outputSends,
    windowSends,
    windowKB: +(windowBytes / 1024).toFixed(1),
    mobileFrames,
    mobileKB: +(mobileBytes / 1024).toFixed(1),
    cloneMs: +cloneMs.toFixed(1)
  }
}

describe('renderer IPC + mobile WS payload while streaming', () => {
  it('counts transcript:changed bytes for one streamed 20 KB and 100 KB answer', async () => {
    const rows: string[] = []
    for (const kb of [20, 100]) {
      const s = await streamAnswer(kb)
      rows.push(
        `  ${kb} KB answer (+${kb * 2} KB tool output): window ${s.windowSends} sends / ${s.windowKB} KB` +
        ` (structuredClone ${s.cloneMs} ms total) | mobile WS ${s.mobileFrames} frames / ${s.mobileKB} KB per client`
      )
      expect(s.windowKB).toBeGreaterThan(0)
      expect(s.mobileKB).toBeGreaterThan(0)
      // The renderer only consumes the durable projection (`transcript:changed`).
      expect(s.outputSends).toBe(0)
    }
    console.log('[perf] transcript:changed while streaming one answer\n' + rows.join('\n'))
  }, 120_000)
})
