import { describe, it, expect } from 'vitest'
import {
  buildContextHandoff,
  contextHandoffSettingKey,
  estimateTokens,
  harnessLabel,
  parseContextHandoffMarker,
  CONTEXT_HANDOFF_DEFAULT_TOKEN_BUDGET
} from './context-handoff'

type Part = Parameters<typeof buildContextHandoff>[0][number]

let nextSeq = 1
function turn(role: string, content: string, partType = 'text'): Part {
  return { seq: nextSeq++, role, content, partType, tool: undefined }
}
function toolResult(name: string, content: string): Part {
  return { seq: nextSeq++, role: 'assistant', content, partType: 'tool', tool: { name } }
}

/** Text of `n` characters, so token cost is predictable (4 chars = 1 token). */
function text(prefix: string, tokens: number): string {
  const body = 'x'.repeat(Math.max(0, tokens * 4 - prefix.length - 1))
  return `${prefix} ${body}`
}

const AGENT = 'Backend Agent (Claude Code)'

/** Only the messages carried in full (not the reference list) */
function carried(result: { text: string }): string {
  return result.text.split('\n').filter((line) => line.startsWith('[#')).join('\n')
}

describe('estimateTokens', () => {
  it('rounds up at four characters per token', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })
})

describe('buildContextHandoff', () => {
  it('returns null when nothing in the transcript can be handed over', () => {
    nextSeq = 1
    expect(buildContextHandoff([], { previousAgentLabel: AGENT })).toBeNull()
    expect(
      buildContextHandoff(
        [turn('assistant', '   ', 'text'), turn('assistant', 'thinking…', 'reasoning'), turn('system', 'note', 'error')],
        { previousAgentLabel: AGENT }
      )
    ).toBeNull()
  })

  it('carries the whole conversation in chronological order when it fits', () => {
    nextSeq = 1
    const parts = [
      turn('user', 'Fix the login bug'),
      turn('assistant', 'Looking at auth.ts'),
      toolResult('bash', 'npm test: 3 failed'),
      turn('assistant', 'Found it: token expiry'),
    ]
    const result = buildContextHandoff(parts, { previousAgentLabel: AGENT, tokenBudget: 1000 })!

    expect(result.carried).toBe(4)
    expect(result.omitted).toBe(0)
    expect(result.text).toContain(`## Conversation so far with ${AGENT}`)
    const order = ['[#1 user] Fix the login bug', '[#2 assistant] Looking at auth.ts', '[#3 tool bash] npm test: 3 failed', '[#4 assistant] Found it: token expiry']
    const positions = order.map((line) => result.text.indexOf(line))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(result.text).not.toContain('Omitted from this handoff')
  })

  it('never exceeds the token budget for carried messages', () => {
    nextSeq = 1
    const parts = Array.from({ length: 30 }, (_, i) => turn(i % 2 ? 'assistant' : 'user', text(`m${i}`, 200)))
    const budget = 1000
    const result = buildContextHandoff(parts, { previousAgentLabel: AGENT, tokenBudget: budget })!

    expect(result.usedTokens).toBeLessThanOrEqual(budget)
    expect(result.carried + result.omitted).toBe(30)
    expect(result.carried).toBeGreaterThan(0)
  })

  it('keeps the original request first even when the budget only fits it and the newest turn', () => {
    nextSeq = 1
    const parts = [
      turn('user', text('REQUEST', 100)),
      turn('assistant', text('old-a', 300)),
      turn('user', text('old-b', 300)),
      turn('assistant', text('newest', 100)),
    ]
    const result = buildContextHandoff(parts, { previousAgentLabel: AGENT, tokenBudget: 250 })!

    expect(carried(result)).toContain('REQUEST')
    expect(carried(result)).toContain('newest')
    expect(carried(result)).not.toContain('old-a')
    expect(carried(result)).not.toContain('old-b')
    expect(result.carried).toBe(2)
    expect(result.omitted).toBe(2)
  })

  it('prefers recent turns over older ones and keeps the recent turns contiguous', () => {
    nextSeq = 1
    const parts = [
      turn('user', 'original'),
      turn('assistant', text('older-small', 10)),
      turn('user', text('big-middle', 400)),
      turn('assistant', text('recent', 50)),
    ]
    // Budget fits the request and the recent turn, but not the large middle turn.
    // The small older turn must not be carried across the gap the big turn left.
    const result = buildContextHandoff(parts, { previousAgentLabel: AGENT, tokenBudget: 120 })!

    expect(carried(result)).toContain('original')
    expect(carried(result)).toContain('recent')
    expect(carried(result)).not.toContain('big-middle')
    expect(carried(result)).not.toContain('older-small')
    expect(result.omitted).toBe(2)
  })

  it('carries messages whole and never cuts one in the middle', () => {
    nextSeq = 1
    const huge = text('HUGE', 5000)
    const parts = [turn('user', 'request'), turn('assistant', huge)]
    const result = buildContextHandoff(parts, { previousAgentLabel: AGENT, tokenBudget: 200 })!

    // The reference preview is short; the full body is never carried.
    expect(carried(result)).not.toContain('HUGE')
    expect(result.text).not.toContain('x'.repeat(500))
    expect(result.carried).toBe(1)
    expect(result.omitted).toBe(1)
  })

  it('carries tool results only after turns, and only when they fit the remaining budget', () => {
    nextSeq = 1
    const parts = [
      turn('user', text('request', 20)),
      toolResult('grep', text('TOOL_OLD', 40)),
      turn('assistant', text('answer', 20)),
      toolResult('bash', text('TOOL_HUGE', 400)),
    ]
    const result = buildContextHandoff(parts, { previousAgentLabel: AGENT, tokenBudget: 120 })!

    expect(carried(result)).toContain('answer')
    expect(carried(result)).toContain('TOOL_OLD')
    expect(carried(result)).not.toContain('TOOL_HUGE')
    expect(result.text).toContain('- #4 tool bash:') // referenced, not carried
  })

  it('lists omitted messages as references the agent can fetch by seq', () => {
    nextSeq = 1
    const parts = [
      turn('user', 'request'),
      turn('assistant', text('OMITTED_MIDDLE', 300)),
      turn('user', 'latest question'),
    ]
    const result = buildContextHandoff(parts, { previousAgentLabel: AGENT, tokenBudget: 60 })!

    expect(result.omitted).toBe(1)
    expect(result.text).toContain('### Omitted from this handoff (1)')
    expect(result.text).toContain('get_messages')
    expect(result.text).toContain('- #2 assistant: "OMITTED_MIDDLE')
  })

  it('truncates long reference previews and caps the number of references', () => {
    nextSeq = 1
    const parts: Part[] = [turn('user', 'request')]
    for (let i = 0; i < 40; i++) parts.push(turn('assistant', text(`LONG${i}`, 200)))
    parts.push(turn('user', 'latest'))
    const result = buildContextHandoff(parts, { previousAgentLabel: AGENT, tokenBudget: 150 })!

    const refLines = result.text.split('\n').filter((line) => line.startsWith('- #'))
    expect(refLines.length).toBeLessThanOrEqual(26) // 25 listed plus one "earlier omitted" summary line
    expect(result.text).toMatch(/…and \d+ earlier omitted message\(s\)/)
    expect(result.omitted).toBeGreaterThan(25)
    for (const line of refLines) expect(line.length).toBeLessThan(160)
  })

  it('uses the default budget of 16k tokens when none is given', () => {
    nextSeq = 1
    expect(CONTEXT_HANDOFF_DEFAULT_TOKEN_BUDGET).toBe(16_000)
    const parts = Array.from({ length: 200 }, (_, i) => turn(i % 2 ? 'assistant' : 'user', text(`m${i}`, 500)))
    const result = buildContextHandoff(parts, { previousAgentLabel: AGENT })!

    expect(result.usedTokens).toBeLessThanOrEqual(16_000)
    expect(result.omitted).toBeGreaterThan(0)
  })

  it('still returns a block when every message is omitted, so the agent knows where to look', () => {
    nextSeq = 1
    const parts = [turn('user', text('request', 500))]
    const result = buildContextHandoff(parts, { previousAgentLabel: AGENT, tokenBudget: 10 })!

    expect(result.carried).toBe(0)
    expect(result.omitted).toBe(1)
    expect(result.text).toContain('No earlier messages fit')
    expect(result.text).toContain('- #1 user:')
  })
})

describe('context handoff markers and labels', () => {
  it('namespaces the setting key per task', () => {
    expect(contextHandoffSettingKey('task-9')).toBe('context-handoff:task-9')
  })

  it('round-trips a marker and ignores malformed values', () => {
    const raw = JSON.stringify({ fromAgentId: 'agent-a', recordedAt: 5 })
    expect(parseContextHandoffMarker(raw)).toEqual({ fromAgentId: 'agent-a', recordedAt: 5 })
    expect(parseContextHandoffMarker(JSON.stringify({ fromAgentId: null }))).toEqual({ fromAgentId: null, recordedAt: 0 })
    expect(parseContextHandoffMarker(undefined)).toBeNull()
    expect(parseContextHandoffMarker('not json')).toBeNull()
    expect(parseContextHandoffMarker('null')).toBeNull()
  })

  it('names the harness behind an agent config value', () => {
    expect(harnessLabel('claude-code')).toBe('Claude Code')
    expect(harnessLabel('codex')).toBe('Codex')
    expect(harnessLabel('opencode')).toBe('OpenCode')
    expect(harnessLabel(undefined)).toBe('agent')
  })
})
