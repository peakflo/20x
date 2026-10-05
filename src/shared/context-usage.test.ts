import { describe, expect, it } from 'vitest'
import {
  AUTO_COMPACT_TOKENS_MAX,
  AUTO_COMPACT_TOKENS_MIN,
  contextWindowCapForModel,
  harnessCanCompact,
  contextUsageLevel,
  contextUsagePercent,
  formatContextTokens,
  isCompactCommand,
  mergeContextUsage,
  normalizeAutoCompactTokens,
  type ContextUsageSnapshot
} from './context-usage'

describe('contextUsagePercent', () => {
  it('computes used / max as a percentage', () => {
    expect(contextUsagePercent(50_000, 200_000)).toBe(25)
  })

  it('is unclamped when usage exceeds the window', () => {
    expect(contextUsagePercent(250_000, 200_000)).toBe(125)
  })

  it('returns null when either side is unknown or the window is empty', () => {
    expect(contextUsagePercent(null, 200_000)).toBeNull()
    expect(contextUsagePercent(10, null)).toBeNull()
    expect(contextUsagePercent(10, 0)).toBeNull()
    expect(contextUsagePercent(-1, 200_000)).toBeNull()
  })
})

describe('contextUsageLevel', () => {
  it('colours by threshold', () => {
    expect(contextUsageLevel(10)).toBe('normal')
    expect(contextUsageLevel(69.9)).toBe('normal')
    expect(contextUsageLevel(70)).toBe('warning')
    expect(contextUsageLevel(89.9)).toBe('warning')
    expect(contextUsageLevel(90)).toBe('critical')
    expect(contextUsageLevel(140)).toBe('critical')
  })

  it('treats unknown usage as normal', () => {
    expect(contextUsageLevel(null)).toBe('normal')
    expect(contextUsageLevel(undefined)).toBe('normal')
  })
})

describe('formatContextTokens', () => {
  it('formats token counts compactly', () => {
    expect(formatContextTokens(950)).toBe('950')
    expect(formatContextTokens(1_000)).toBe('1k')
    expect(formatContextTokens(12_345)).toBe('12.3k')
    expect(formatContextTokens(200_000)).toBe('200k')
    expect(formatContextTokens(1_000_000)).toBe('1M')
    expect(formatContextTokens(1_500_000)).toBe('1.5M')
  })

  it('renders an em dash for unknown values', () => {
    expect(formatContextTokens(null)).toBe('—')
    expect(formatContextTokens(Number.NaN)).toBe('—')
  })
})

describe('normalizeAutoCompactTokens', () => {
  it('keeps values in range and rounds to 1k', () => {
    expect(normalizeAutoCompactTokens(150_400)).toBe(150_000)
    expect(normalizeAutoCompactTokens(150_600)).toBe(151_000)
  })

  it('clamps to the supported range', () => {
    expect(normalizeAutoCompactTokens(1)).toBe(AUTO_COMPACT_TOKENS_MIN)
    expect(normalizeAutoCompactTokens(5_000_000)).toBe(AUTO_COMPACT_TOKENS_MAX)
  })

  it('treats off and invalid values as null', () => {
    expect(normalizeAutoCompactTokens(null)).toBeNull()
    expect(normalizeAutoCompactTokens(undefined)).toBeNull()
    expect(normalizeAutoCompactTokens('200000')).toBeNull()
    expect(normalizeAutoCompactTokens(Number.NaN)).toBeNull()
  })
})

describe('isCompactCommand', () => {
  it('matches the /compact command with surrounding whitespace only', () => {
    expect(isCompactCommand('/compact')).toBe(true)
    expect(isCompactCommand('  /compact \n')).toBe(true)
    expect(isCompactCommand('/compact now')).toBe(false)
    expect(isCompactCommand('please /compact')).toBe(false)
    expect(isCompactCommand(null)).toBe(false)
  })
})

describe('mergeContextUsage', () => {
  const meta = { taskId: 'task-1', agentId: 'agent-1', codingAgent: 'claude-code', now: '2026-10-05T10:00:00.000Z' }

  it('creates a snapshot from the first report', () => {
    const snapshot = mergeContextUsage(undefined, { usedTokens: 50_000, maxTokens: 200_000, model: 'claude-sonnet' }, meta)
    expect(snapshot).toEqual<ContextUsageSnapshot>({
      taskId: 'task-1',
      agentId: 'agent-1',
      codingAgent: 'claude-code',
      usedTokens: 50_000,
      maxTokens: 200_000,
      percent: 25,
      model: 'claude-sonnet',
      compacting: false,
      canCompact: false,
      updatedAt: '2026-10-05T10:00:00.000Z'
    })
  })

  it('keeps previous fields the partial report leaves out', () => {
    const first = mergeContextUsage(undefined, { usedTokens: 50_000, maxTokens: 200_000, canCompact: true }, meta)
    const next = mergeContextUsage(first, { compacting: true }, { ...meta, now: '2026-10-05T10:01:00.000Z' })
    expect(next.usedTokens).toBe(50_000)
    expect(next.maxTokens).toBe(200_000)
    expect(next.percent).toBe(25)
    expect(next.canCompact).toBe(true)
    expect(next.compacting).toBe(true)
    expect(next.updatedAt).toBe('2026-10-05T10:01:00.000Z')
  })

  it('replaces usage after a compaction and recomputes the percentage', () => {
    const before = mergeContextUsage(undefined, { usedTokens: 180_000, maxTokens: 200_000, compacting: true }, meta)
    const after = mergeContextUsage(before, { usedTokens: 20_000, compacting: false }, meta)
    expect(after.percent).toBe(10)
    expect(after.compacting).toBe(false)
  })

  it('keeps the known window when only usage changes', () => {
    const first = mergeContextUsage(undefined, { usedTokens: 1_000, maxTokens: null }, meta)
    expect(first.percent).toBeNull()
    const second = mergeContextUsage(first, { usedTokens: 2_000, maxTokens: 1_000_000 }, meta)
    expect(second.percent).toBeCloseTo(0.2)
  })
})

describe('auto-compact cap per model', () => {
  it('caps standard models at 200k and [1m] models at 1M', () => {
    expect(contextWindowCapForModel('claude-sonnet-4-5')).toBe(200_000)
    expect(contextWindowCapForModel('claude-opus-4-7[1m]')).toBe(1_000_000)
    expect(normalizeAutoCompactTokens(500_000, 'claude-sonnet-4-5')).toBe(200_000)
    expect(normalizeAutoCompactTokens(500_000, 'claude-opus-4-7[1m]')).toBe(500_000)
    expect(normalizeAutoCompactTokens(500_000)).toBe(500_000)
  })
})

describe('harnessCanCompact', () => {
  it('is true only for harnesses that accept /compact', () => {
    expect(harnessCanCompact('claude-code')).toBe(true)
    expect(harnessCanCompact('codex')).toBe(true)
    expect(harnessCanCompact('opencode')).toBe(false)
    expect(harnessCanCompact('cursor')).toBe(false)
    expect(harnessCanCompact(null)).toBe(false)
  })
})

describe('unknownUsage', () => {
  it('clears used tokens instead of keeping the previous figure', () => {
    const before = mergeContextUsage(undefined, { usedTokens: 180_000, maxTokens: 200_000 }, { taskId: 't' })
    const after = mergeContextUsage(before, { unknownUsage: true }, { taskId: 't' })
    expect(after.usedTokens).toBeNull()
    expect(after.percent).toBeNull()
    expect(after.maxTokens).toBe(200_000)
  })
})
