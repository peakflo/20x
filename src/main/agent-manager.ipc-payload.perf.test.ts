/**
 * Bytes pushed to the renderer window while one agent streams an answer.
 *
 * Replays a realistic stream through the REAL `sendToRenderer` path with a real
 * (in-memory) transcript store: 200 polls; every poll re-sends the growing
 * assistant text in full (as the adapters do with `update: true`), finishing
 * at 20 KB, and every 10th poll adds a tool call with 2 KB of output.
 *
 * Bytes are `JSON.stringify(payload).length` per `webContents.send`, used as a
 * proxy for the structured-clone/serialization work on both sides of IPC.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentManager } from './agent-manager'
import { createTestDb } from '../../test/helpers/db-test-helper'

vi.mock('./task-api-server', () => ({ getTaskApiPort: vi.fn(), waitForTaskApiServer: vi.fn() }))

afterEach(() => { vi.useRealTimers() })

describe('renderer IPC payload while streaming', () => {
  it('counts bytes per channel for one streamed 20 KB answer', async () => {
    vi.useFakeTimers()
    const { db } = createTestDb()
    const task = db.createTask({ title: 'Streaming task' })!
    const mgr = new AgentManager(db)
    const bytes: Record<string, number> = {}
    const sends: Record<string, number> = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(mgr as any).mainWindow = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => {
          bytes[channel] = (bytes[channel] ?? 0) + JSON.stringify(payload ?? null).length
          sends[channel] = (sends[channel] ?? 0) + 1
        }
      }
    }

    const POLLS = 200
    let text = ''
    for (let poll = 0; poll < POLLS; poll++) {
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

    const outputBytes = (bytes['agent:output-batch'] ?? 0) + (bytes['agent:output'] ?? 0)
    const changedBytes = bytes['transcript:changed'] ?? 0
    console.log(
      '[perf] renderer IPC while streaming one 20 KB answer (200 polls)\n' +
      `  agent:output* sends / KB: ${(sends['agent:output-batch'] ?? 0) + (sends['agent:output'] ?? 0)} / ${(outputBytes / 1024).toFixed(1)}\n` +
      `  transcript:changed sends / KB: ${sends['transcript:changed'] ?? 0} / ${(changedBytes / 1024).toFixed(1)}\n` +
      `  total KB to window: ${(Object.values(bytes).reduce((a, b) => a + b, 0) / 1024).toFixed(1)}`
    )
    // The renderer only consumes the durable projection (`transcript:changed`).
    expect(changedBytes).toBeGreaterThan(0)
    expect(outputBytes).toBe(0)
  })
})
