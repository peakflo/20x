import { describe, it, expect } from 'vitest'
import {
  buildUsageChartSeries,
  effectiveUsedPercent,
  formatMultiplier,
  formatResetIn,
  formatTokenCount,
  formatUsd,
  mergeUsageLimits,
  totalTokens,
  usageLimitLevel,
  usagePeriodForParallelismDays,
  type ProviderUsageLimits
} from './usage'

const CHECKED = '2026-10-05T10:00:00.000Z'

describe('mergeUsageLimits', () => {
  const base: ProviderUsageLimits = {
    provider: 'codex',
    checkedAt: '2026-10-05T09:00:00.000Z',
    planType: 'pro',
    windows: [
      { id: 'primary', kind: 'session', label: '5-hour', usedPercent: 10, resetsAt: '2026-10-05T12:00:00.000Z', windowDurationMins: 300 },
      { id: 'secondary', kind: 'weekly', label: 'Weekly', usedPercent: 40, resetsAt: '2026-10-09T00:00:00.000Z', windowDurationMins: 10_080 }
    ],
    limitReached: false,
    resetCreditsAvailable: null,
    unavailable: null
  }

  it('upserts windows by id and keeps fields the update omits', () => {
    const merged = mergeUsageLimits('codex', base, {
      windows: [{ id: 'primary', kind: 'session', label: '5-hour', usedPercent: 25 }]
    }, CHECKED)
    expect(merged).not.toBe(base)
    expect(merged.checkedAt).toBe(CHECKED)
    expect(merged.planType).toBe('pro')
    expect(merged.windows[0]).toEqual({
      id: 'primary', kind: 'session', label: '5-hour', usedPercent: 25,
      resetsAt: '2026-10-05T12:00:00.000Z', windowDurationMins: 300
    })
    expect(merged.windows[1].usedPercent).toBe(40)
  })

  it('returns the same object when nothing changed', () => {
    expect(mergeUsageLimits('codex', base, {
      windows: [{ id: 'primary', kind: 'session', label: '5-hour', usedPercent: 10 }]
    }, CHECKED)).toBe(base)
  })

  it('creates a snapshot from the first update and clears a stale failure', () => {
    const fresh = mergeUsageLimits('claude-code', null, {
      windows: [{ id: 'weekly', kind: 'weekly', label: 'Weekly', usedPercent: 5 }],
      limitReached: true
    }, CHECKED)
    expect(fresh).toMatchObject({ provider: 'claude-code', limitReached: true, unavailable: null })

    const failed = { ...base, unavailable: { reason: 'probe_failed' as const, message: 'x' } }
    expect(mergeUsageLimits('codex', failed, { windows: [] }, CHECKED).unavailable).toBeNull()
  })

  it('sorts session windows before weekly ones', () => {
    const merged = mergeUsageLimits('claude-code', null, {
      windows: [
        { id: 'seven_day', kind: 'weekly', label: 'Weekly', usedPercent: 1 },
        { id: 'five_hour', kind: 'session', label: '5-hour', usedPercent: 2 }
      ]
    }, CHECKED)
    expect(merged.windows.map((w) => w.id)).toEqual(['five_hour', 'seven_day'])
  })
})

describe('usage helpers', () => {
  const now = Date.parse('2026-10-05T10:00:00.000Z')

  it('treats a window whose reset passed as unused', () => {
    expect(effectiveUsedPercent({ id: 'a', kind: 'session', label: '', usedPercent: 90, resetsAt: '2026-10-05T09:59:00.000Z' }, now)).toBe(0)
    expect(effectiveUsedPercent({ id: 'a', kind: 'session', label: '', usedPercent: 120, resetsAt: '2026-10-05T11:00:00.000Z' }, now)).toBe(100)
  })

  it('classifies limit levels', () => {
    expect(usageLimitLevel(75)).toBe('normal')
    expect(usageLimitLevel(75.5)).toBe('warning')
    expect(usageLimitLevel(90)).toBe('warning')
    expect(usageLimitLevel(91)).toBe('critical')
  })

  it('formats tokens, cost and reset times', () => {
    expect(formatTokenCount(950)).toBe('950')
    expect(formatTokenCount(1_500)).toBe('1.5K')
    expect(formatTokenCount(25_000_000)).toBe('25M')
    expect(formatUsd(null)).toBe('—')
    expect(formatUsd(0.004)).toBe('<$0.01')
    expect(formatUsd(12.345)).toBe('$12.35')
    expect(formatResetIn('2026-10-05T10:30:00.000Z', now)).toBe('in 30m')
    expect(formatResetIn('2026-10-05T12:15:00.000Z', now)).toBe('in 2h 15m')
    expect(formatResetIn('2026-10-08T13:00:00.000Z', now)).toBe('in 3d 3h')
    expect(formatResetIn('2026-10-05T09:00:00.000Z', now)).toBe('now')
    expect(formatResetIn(null, now)).toBeNull()
  })

  it('counts reasoning inside output when totalling tokens', () => {
    expect(totalTokens({ inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4, reasoningTokens: 4 })).toBe(10)
  })
})

describe('formatMultiplier', () => {
  it('shows one decimal below 10 and a rounded integer at 10+', () => {
    expect(formatMultiplier(3.44)).toBe('3.4')
    expect(formatMultiplier(10)).toBe('10')
    expect(formatMultiplier(137.2)).toBe('137')
  })

  it('caps absurd multipliers at ">1000×" instead of a wall of digits', () => {
    expect(formatMultiplier(1000)).toBe('>1000×')
    expect(formatMultiplier(48_231)).toBe('>1000×')
    expect(formatMultiplier(999.4)).toBe('999') // just under the cap, still a rounded integer
  })
})

describe('usagePeriodForParallelismDays', () => {
  it('maps every supported period to its UsagePeriod key', () => {
    expect(usagePeriodForParallelismDays(7)).toBe('7d')
    expect(usagePeriodForParallelismDays(30)).toBe('30d')
    expect(usagePeriodForParallelismDays(90)).toBe('90d')
    expect(usagePeriodForParallelismDays(182)).toBe('182d')
  })
})

describe('buildUsageChartSeries', () => {
  it('assigns the first 4 providers (by the fixed USAGE_PROVIDERS order) real colours', () => {
    const series = buildUsageChartSeries(['cursor', 'claude-code', 'codex'], 'dark')
    expect(series.map((s) => s.key)).toEqual(['claude-code', 'codex', 'cursor'])
    expect(series.every((s) => s.color.startsWith('#'))).toBe(true)
  })

  it('folds a 5th+ provider into one "Other" series instead of growing the palette', () => {
    const series = buildUsageChartSeries(['claude-code', 'codex', 'opencode', 'cursor', 'pi', 'acp'], 'dark')
    expect(series).toHaveLength(5)
    const other = series.find((s) => s.key === 'other')!
    expect(other.providers).toEqual(['pi', 'acp'])
    expect(other.label).toBe('Other')
  })

  it('uses the light-theme palette when asked, and never colours text with a series colour', () => {
    const dark = buildUsageChartSeries(['claude-code'], 'dark')
    const light = buildUsageChartSeries(['claude-code'], 'light')
    expect(dark[0].color).not.toBe(light[0].color)
  })

  it('omits providers with no data entirely, in any input order', () => {
    const series = buildUsageChartSeries(['acp', 'claude-code'], 'dark')
    expect(series.map((s) => s.key)).toEqual(['claude-code', 'acp'])
  })
})
