import { describe, it, expect } from 'vitest'
import { assistantTextParts, sinceLastUserMessage } from './voice-answer-parts'

/**
 * One turn can hold several messages. The reported bug: an agent says
 * something, uses a tool, and says something else — and only the last message
 * was read aloud, because the reader took "the newest message".
 */

const TURN = [
  { partId: 'u1', role: 'user', content: 'Why did the test fail?' },
  { partId: 't1', role: 'assistant', content: 'Let me look at the test.', partType: 'text' },
  { partId: 'tool1', role: 'assistant', content: 'ran the suite', partType: 'tool' },
  { partId: 't2', role: 'assistant', content: 'The token expired.', partType: 'text' },
]

describe('assistantTextParts', () => {
  it('keeps every message of the turn, in order', () => {
    expect(assistantTextParts(TURN)).toEqual([
      { partId: 't1', content: 'Let me look at the test.' },
      { partId: 't2', content: 'The token expired.' },
    ])
  })

  it('never reads a tool call, a question, an error or hidden reasoning', () => {
    const parts = assistantTextParts([
      { partId: 'a', role: 'assistant', content: 'The answer.', partType: 'text' },
      { partId: 'b', role: 'assistant', content: 'ls -la', partType: 'tool' },
      { partId: 'c', role: 'assistant', content: 'thinking', partType: 'reasoning' },
      { partId: 'd', role: 'assistant', content: 'it broke', partType: 'error' },
      { partId: 'e', role: 'assistant', content: 'pick one', partType: 'question' },
    ])
    expect(parts.map((p) => p.partId)).toEqual(['a'])
  })

  it('accepts a message with no type, which is plain text', () => {
    expect(assistantTextParts([{ partId: 'a', role: 'assistant', content: 'Plain.' }])).toHaveLength(1)
  })

  it('skips an empty message', () => {
    expect(assistantTextParts([{ partId: 'a', role: 'assistant', content: '   ', partType: 'text' }])).toEqual([])
  })

  it('skips what the user said', () => {
    expect(assistantTextParts([{ partId: 'u', role: 'user', content: 'Hello?' }])).toEqual([])
  })
})

describe('sinceLastUserMessage', () => {
  it('takes this turn and not the whole conversation', () => {
    const conversation = [
      { partId: 'u0', role: 'user', content: 'First question' },
      { partId: 'a0', role: 'assistant', content: 'An old answer.', partType: 'text' },
      ...TURN,
    ]
    const turn = sinceLastUserMessage(conversation)

    expect(assistantTextParts(turn).map((p) => p.partId)).toEqual(['t1', 't2'])
    // The old answer stays unread; it was answered long ago.
    expect(turn.some((p) => p.partId === 'a0')).toBe(false)
  })

  it('takes everything when the user has not spoken', () => {
    const parts = [{ partId: 'a', role: 'assistant', content: 'Hello.', partType: 'text' }]
    expect(sinceLastUserMessage(parts)).toEqual(parts)
  })

  it('copes with an empty transcript', () => {
    expect(sinceLastUserMessage([])).toEqual([])
  })
})
