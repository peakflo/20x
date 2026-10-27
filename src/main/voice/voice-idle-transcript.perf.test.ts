/**
 * Main-process cost of the voice watcher's `working -> idle` read.
 *
 * `watchAgentAnswersForSpeech` (src/main/index.ts) runs on the idle edge of
 * EVERY agent turn of EVERY task, voice or not, and needs only this turn: the
 * parts after the last user message. It used to read the whole transcript
 * (`getTranscriptParts` + `sinceLastUserMessage`); it now reads only the turn
 * (`getTranscriptPartsSinceLastUserMessage`). Both paths run here on the same
 * database, so one run gives the before and after numbers.
 *
 * Seed (real file-backed DB through the production `initialize()`): one task
 * with 5,000 transcript parts — a user message every 50 parts, assistant text
 * of ~600 B, every third part a tool call with ~3 KB of tool JSON. The current
 * turn is the last 40 parts.
 *
 * Printed: median ms, rows and KB materialized per idle edge.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { sinceLastUserMessage } from './voice-answer-parts'
import { createPerfDb, printResults, timeAsync } from '../../../test/helpers/perf-helpers'

const PARTS = 5000
const TURN = 40
const results: Record<string, string | number> = {}
afterAll(() => printResults('voice watcher idle edge: one 5,000-part transcript', results))

describe('voice watcher idle-edge transcript read', { timeout: 120_000 }, () => {
  it('reads only the current turn', async () => {
    const { db, cleanup } = createPerfDb('20x-voice-perf-')
    try {
      const task = db.createTask({ title: 'Long conversation' })!
      const base = 1_750_000_000_000
      const parts = Array.from({ length: PARTS }, (_, i) => {
        const fromEnd = PARTS - i
        const isUser = fromEnd === TURN + 1 || (fromEnd > TURN + 1 && i % 50 === 0)
        const isTool = !isUser && i % 3 === 0
        return {
          id: `p-${i}`,
          role: isUser ? 'user' : 'assistant',
          content: isUser ? `Question ${i}` : isTool ? '' : `Answer ${i} `.repeat(50),
          partType: isTool ? 'tool' : 'text',
          tool: isTool
            ? { name: 'Bash', status: 'completed', input: JSON.stringify({ command: `ls ${i}` }), output: 'o'.repeat(3000) }
            : undefined,
          receivedAt: base + i * 1000
        }
      })
      for (let i = 0; i < parts.length; i += 500) db.upsertTranscriptParts(task.id, parts.slice(i, i + 500))

      const before = sinceLastUserMessage(db.getTranscriptParts(task.id))
      const after = db.getTranscriptPartsSinceLastUserMessage(task.id)
      expect(after).toEqual(before)
      expect(after).toHaveLength(TURN)

      const all = db.getTranscriptParts(task.id)
      results['before: rows / KB materialized'] = `${all.length} / ${(JSON.stringify(all).length / 1024).toFixed(0)}`
      results['after:  rows / KB materialized'] = `${after.length} / ${(JSON.stringify(after).length / 1024).toFixed(0)}`
      results['before: median ms (getTranscriptParts + sinceLastUserMessage)'] =
        (await timeAsync(21, () => sinceLastUserMessage(db.getTranscriptParts(task.id)))).toFixed(2)
      results['after:  median ms (getTranscriptPartsSinceLastUserMessage)'] =
        (await timeAsync(21, () => db.getTranscriptPartsSinceLastUserMessage(task.id))).toFixed(2)
    } finally {
      cleanup()
    }
  })
})
