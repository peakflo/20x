import { describe, it, expect } from 'vitest'
import { buildAgentSwitchRecap } from './agent-handoff'

describe('buildAgentSwitchRecap', () => {
  it('returns empty string for a fresh task with no transcript', () => {
    expect(buildAgentSwitchRecap([])).toBe('')
  })

  it('recaps user asks and plain-text agent replies, in order', () => {
    const recap = buildAgentSwitchRecap([
      { partId: 'u1', role: 'user', content: 'Add a login form.' },
      { partId: 'a1', role: 'assistant', content: 'Added LoginForm.tsx.', partType: 'text' },
      { partId: 'u2', role: 'user', content: 'Now wire it to the API.' },
    ])
    expect(recap).toBe(
      'User: Add a login form.\n\n' +
      'Previous agent: Added LoginForm.tsx.\n\n' +
      'User: Now wire it to the API.'
    )
  })

  it('skips tool calls, reasoning, errors and questions', () => {
    const recap = buildAgentSwitchRecap([
      { partId: 'u1', role: 'user', content: 'Fix the failing test.' },
      { partId: 't1', role: 'assistant', content: 'npm test', partType: 'tool' },
      { partId: 'r1', role: 'assistant', content: 'thinking about it', partType: 'reasoning' },
      { partId: 'e1', role: 'assistant', content: 'crashed', partType: 'error' },
      { partId: 'q1', role: 'assistant', content: 'Which branch?', partType: 'question' },
      { partId: 'a1', role: 'assistant', content: 'Fixed the token expiry check.', partType: 'text' },
    ])
    expect(recap).toBe('User: Fix the failing test.\n\nPrevious agent: Fixed the token expiry check.')
  })

  it('returns empty string when only skipped part types exist', () => {
    const recap = buildAgentSwitchRecap([
      { partId: 't1', role: 'assistant', content: 'npm test', partType: 'tool' },
      { partId: 'e1', role: 'assistant', content: 'crashed', partType: 'error' },
    ])
    expect(recap).toBe('')
  })

  it('skips blank content', () => {
    const recap = buildAgentSwitchRecap([
      { partId: 'u1', role: 'user', content: '   ' },
      { partId: 'a1', role: 'assistant', content: 'Done.', partType: 'text' },
    ])
    expect(recap).toBe('Previous agent: Done.')
  })

  it('truncates to the tail when the transcript exceeds maxChars', () => {
    const recap = buildAgentSwitchRecap(
      [
        { partId: 'u1', role: 'user', content: 'first message' },
        { partId: 'u2', role: 'user', content: 'last message' },
      ],
      20
    )
    expect(recap.startsWith('…(earlier conversation omitted)…')).toBe(true)
    expect(recap.endsWith('last message')).toBe(true)
    expect(recap).not.toContain('first message')
  })
})
