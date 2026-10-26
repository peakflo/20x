import { describe, expect, it } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { sinceLastUserMessage } from './voice/voice-answer-parts'
import type { TranscriptPartInput } from './database'

/**
 * `getTranscriptPartsSinceLastUserMessage` must return exactly what the voice
 * watcher used to compute from the full transcript.
 */
describe('getTranscriptPartsSinceLastUserMessage', () => {
  function seed(parts: TranscriptPartInput[]) {
    const { db } = createTestDb()
    const task = db.createTask({ title: 'T' })!
    db.upsertTranscriptParts(task.id, parts)
    const expected = sinceLastUserMessage(db.getTranscriptParts(task.id))
    return { actual: db.getTranscriptPartsSinceLastUserMessage(task.id), expected, db, taskId: task.id }
  }

  it('returns the parts after the last user message', () => {
    const { actual, expected } = seed([
      { id: 'u1', role: 'user', content: 'first', receivedAt: 1000 },
      { id: 'a1', role: 'assistant', content: 'one', receivedAt: 2000 },
      { id: 'u2', role: 'user', content: 'second', receivedAt: 3000 },
      { id: 'a2', role: 'assistant', content: 'two', receivedAt: 4000 },
      { id: 't2', role: 'assistant', content: '', partType: 'tool', tool: { name: 'Bash' }, receivedAt: 5000 }
    ])
    expect(actual.map((p) => p.partId)).toEqual(['a2', 't2'])
    expect(actual).toEqual(expected)
  })

  it('returns the whole transcript when there is no user message', () => {
    const { actual, expected } = seed([
      { id: 'a1', role: 'assistant', content: 'one', receivedAt: 1000 },
      { id: 'a2', role: 'assistant', content: 'two', receivedAt: 2000 }
    ])
    expect(actual).toHaveLength(2)
    expect(actual).toEqual(expected)
  })

  it('returns nothing when the user spoke last', () => {
    const { actual, expected } = seed([
      { id: 'a1', role: 'assistant', content: 'one', receivedAt: 1000 },
      { id: 'u1', role: 'user', content: 'question', receivedAt: 2000 }
    ])
    expect(actual).toEqual([])
    expect(expected).toEqual([])
  })

  it('orders by event time with seq as the tiebreaker, like getTranscriptParts', () => {
    // Same timestamp for the user message and the answer; a part backfilled
    // later with an OLDER timestamp must still count as before the user message.
    const { actual, expected, db, taskId } = seed([
      { id: 'u1', role: 'user', content: 'q', receivedAt: 5000 },
      { id: 'a1', role: 'assistant', content: 'same time', receivedAt: 5000 },
      { id: 'a2', role: 'assistant', content: 'later', receivedAt: 6000 }
    ])
    expect(actual).toEqual(expected)
    db.upsertTranscriptParts(taskId, [{ id: 'old', role: 'assistant', content: 'backfilled', receivedAt: 1000 }])
    const afterBackfill = db.getTranscriptPartsSinceLastUserMessage(taskId)
    expect(afterBackfill).toEqual(sinceLastUserMessage(db.getTranscriptParts(taskId)))
    expect(afterBackfill.map((p) => p.partId)).toEqual(['a1', 'a2'])
  })

  it('is empty for an unknown task', () => {
    const { db } = createTestDb()
    expect(db.getTranscriptPartsSinceLastUserMessage('missing')).toEqual([])
  })
})
