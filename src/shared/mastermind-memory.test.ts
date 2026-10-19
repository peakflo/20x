import { describe, it, expect } from 'vitest'
import {
  buildMastermindMemoryContext,
  clampImportance,
  containsLikelySecret,
  estimateMemoryTokens,
  findDuplicateMemory,
  isValidMemoryKind,
  isValidMemoryScope,
  memoryTextSimilarity,
  normalizeMemoryScope,
  MEMORY_SCOPE_GLOBAL,
  type MastermindMemoryRecord
} from './mastermind-memory'

function memory(overrides: Partial<MastermindMemoryRecord> = {}): MastermindMemoryRecord {
  return {
    id: 'mem-1',
    scope: MEMORY_SCOPE_GLOBAL,
    kind: 'fact',
    content: 'Default content',
    source: 'user-stated',
    importance: 3,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    last_used_at: null,
    expires_at: null,
    pinned: false,
    ...overrides
  }
}

describe('isValidMemoryKind', () => {
  it('accepts every documented kind', () => {
    for (const kind of ['preference', 'decision', 'fact', 'goal', 'person', 'procedure']) {
      expect(isValidMemoryKind(kind)).toBe(true)
    }
  })

  it('rejects anything else', () => {
    expect(isValidMemoryKind('task')).toBe(false)
    expect(isValidMemoryKind(undefined)).toBe(false)
    expect(isValidMemoryKind(42)).toBe(false)
  })
})

describe('isValidMemoryScope / normalizeMemoryScope', () => {
  it('accepts global, project:<id> and repo:<owner/name>', () => {
    expect(isValidMemoryScope('global')).toBe(true)
    expect(isValidMemoryScope('project:abc123')).toBe(true)
    expect(isValidMemoryScope('repo:peakflo/20x')).toBe(true)
  })

  it('rejects malformed scopes', () => {
    expect(isValidMemoryScope('')).toBe(false)
    expect(isValidMemoryScope('project:')).toBe(false)
    expect(isValidMemoryScope('repo:no-slash')).toBe(false)
    expect(isValidMemoryScope(undefined)).toBe(false)
  })

  it('normalizes anything invalid to global', () => {
    expect(normalizeMemoryScope(undefined)).toBe('global')
    expect(normalizeMemoryScope('')).toBe('global')
    expect(normalizeMemoryScope('nonsense')).toBe('global')
    expect(normalizeMemoryScope('project:p1')).toBe('project:p1')
  })
})

describe('clampImportance', () => {
  it('clamps to 1-5 and rounds', () => {
    expect(clampImportance(0)).toBe(1)
    expect(clampImportance(-5)).toBe(1)
    expect(clampImportance(6)).toBe(5)
    expect(clampImportance(3.6)).toBe(4)
  })

  it('defaults to 3 for anything non-numeric', () => {
    expect(clampImportance(undefined)).toBe(3)
    expect(clampImportance('not a number')).toBe(3)
  })
})

describe('memoryTextSimilarity / findDuplicateMemory (dedupe)', () => {
  it('scores identical text as 1', () => {
    expect(memoryTextSimilarity('Always use pnpm', 'Always use pnpm')).toBe(1)
  })

  it('scores unrelated text low', () => {
    expect(memoryTextSimilarity('Always use pnpm', 'The sky is blue today')).toBeLessThan(0.2)
  })

  it('scores a reworded near-duplicate high', () => {
    const score = memoryTextSimilarity('Always use pnpm, never npm or yarn', 'Use pnpm always, never npm/yarn')
    expect(score).toBeGreaterThan(0.6)
  })

  it('finds the best near-duplicate among candidates, above the threshold', () => {
    const candidates = [
      memory({ id: 'a', content: 'The user prefers dark mode' }),
      memory({ id: 'b', content: 'Always use pnpm, never npm or yarn' }),
      memory({ id: 'c', content: 'Deploys happen on Fridays' })
    ]
    const duplicate = findDuplicateMemory(candidates, 'Use pnpm always, never npm/yarn please')
    expect(duplicate?.id).toBe('b')
  })

  it('returns null when nothing is close enough', () => {
    const candidates = [memory({ id: 'a', content: 'The user prefers dark mode' })]
    expect(findDuplicateMemory(candidates, 'Deploys happen on Fridays')).toBeNull()
  })
})

describe('containsLikelySecret', () => {
  const secrets = [
    ['AWS access key', 'my key is AKIAIOSFODNN7EXAMPLE'],
    ['GitHub token', 'use ghp_1234567890abcdefghijklmnopqrstuvwxyzAB for auth'],
    ['OpenAI key', 'sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD'],
    ['Anthropic key', 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789'],
    ['private key block', '-----BEGIN RSA PRIVATE KEY-----\nMIIB...\n-----END RSA PRIVATE KEY-----'],
    ['JWT', 'token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['bearer token', 'Authorization: Bearer abcdef1234567890abcdef'],
    ['credential assignment', 'api_key=sk_live_abcdefghijklmnop1234'],
    ['credentials in URL', 'postgres://user:supersecretpw@db.example.com:5432/app']
  ] as const

  for (const [label, text] of secrets) {
    it(`refuses a ${label}`, () => {
      expect(containsLikelySecret(text).found).toBe(true)
    })
  }

  it('allows an ordinary preference with no credential shape', () => {
    expect(containsLikelySecret('Always use pnpm, never npm or yarn.').found).toBe(false)
  })

  it('allows a sentence that merely mentions "password" without a value', () => {
    expect(containsLikelySecret('Remind me to rotate the password next quarter.').found).toBe(false)
  })
})

describe('buildMastermindMemoryContext ("what you remember" injection)', () => {
  it('returns empty for no memories', () => {
    const result = buildMastermindMemoryContext([], 1500)
    expect(result.text).toBe('')
    expect(result.count).toBe(0)
    expect(result.ids).toEqual([])
  })

  it('puts pinned memories first regardless of importance/recency', () => {
    const memories = [
      memory({ id: 'low-pinned', content: 'Pinned but low importance', importance: 1, pinned: true, updated_at: '2026-01-01T00:00:00.000Z' }),
      memory({ id: 'high-unpinned', content: 'Unpinned but high importance', importance: 5, pinned: false, updated_at: '2026-01-05T00:00:00.000Z' })
    ]
    const result = buildMastermindMemoryContext(memories, 1500)
    expect(result.ids).toEqual(['low-pinned', 'high-unpinned'])
    expect(result.text.indexOf('Pinned but low importance')).toBeLessThan(result.text.indexOf('Unpinned but high importance'))
  })

  it('ranks unpinned memories by importance, then by most-recently-updated', () => {
    const memories = [
      memory({ id: 'old-important', content: 'Old but important', importance: 5, updated_at: '2026-01-01T00:00:00.000Z' }),
      memory({ id: 'new-minor', content: 'New but minor', importance: 1, updated_at: '2026-01-10T00:00:00.000Z' }),
      memory({ id: 'new-important', content: 'New and important', importance: 5, updated_at: '2026-01-10T00:00:00.000Z' })
    ]
    const result = buildMastermindMemoryContext(memories, 1500)
    expect(result.ids).toEqual(['new-important', 'old-important', 'new-minor'])
  })

  it('includes each id so the agent can forget or update it', () => {
    const memories = [memory({ id: 'mem-42', content: 'Remember this one' })]
    const result = buildMastermindMemoryContext(memories, 1500)
    expect(result.text).toContain('[id:mem-42]')
  })

  it('caps total size to the token budget, dropping the lowest-ranked items first', () => {
    // Each unpinned memory costs ~50 tokens (200 chars / 4); a tiny budget keeps only the header plus one or two.
    const memories = Array.from({ length: 20 }, (_, i) =>
      memory({ id: `mem-${i}`, content: 'x'.repeat(200), importance: 3, updated_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` })
    )
    const result = buildMastermindMemoryContext(memories, 150)
    expect(result.count).toBeGreaterThan(0)
    expect(result.count).toBeLessThan(memories.length)
    expect(estimateMemoryTokens(result.text)).toBeLessThanOrEqual(150 + 60) // header + at least one line fits within a small margin
  })

  it('fits the pinned item within a budget too small for any filler, instead of excluding it to make room for nothing', () => {
    const pinned = memory({ id: 'pinned-1', content: 'Short pinned note', pinned: true, updated_at: '2026-01-01T00:00:00.000Z' })
    const filler = Array.from({ length: 10 }, (_, i) =>
      memory({ id: `filler-${i}`, content: 'y'.repeat(100), updated_at: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` })
    )
    // Budget covers the header plus the one short pinned line, but not any 100-char filler line.
    const result = buildMastermindMemoryContext([pinned, ...filler], 100)
    expect(result.ids).toEqual(['pinned-1'])
  })
})
