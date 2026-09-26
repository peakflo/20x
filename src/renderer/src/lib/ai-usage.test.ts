import { describe, it, expect } from 'vitest'
import { parseAiUsage, usageLevel, fetchAiUsage } from './ai-usage'

describe('parseAiUsage', () => {
  it('parses percentUsed payload', () => {
    expect(parseAiUsage({ usage: { percentUsed: 42.4, used: 4, limit: 10, resetAt: '2026-10-01' } })).toEqual({
      percent: 42, used: 4, limit: 10, resetAt: '2026-10-01'
    })
  })
  it('computes from spend / maxBudget and clamps', () => {
    expect(parseAiUsage({ currentSubscription: { status: 'active', spend: 15, maxBudget: 10 } })?.percent).toBe(100)
  })
  it('returns null without subscription', () => {
    expect(parseAiUsage({ currentSubscription: null, plans: [] })).toBeNull()
    expect(parseAiUsage({ hasSubscription: false })).toBeNull()
    expect(parseAiUsage(null)).toBeNull()
    expect(parseAiUsage({ currentSubscription: { status: 'cancelled', spend: 1, maxBudget: 2 } })).toBeNull()
  })
  it('returns null when limit is missing', () => {
    expect(parseAiUsage({ currentSubscription: { status: 'active', spend: 1 } })).toBeNull()
  })
})

describe('usageLevel', () => {
  it('maps thresholds', () => {
    expect(usageLevel(79)).toBe('normal')
    expect(usageLevel(80)).toBe('warn')
    expect(usageLevel(95)).toBe('critical')
  })
})

describe('fetchAiUsage', () => {
  it('falls back to plan endpoint when usage fails', async () => {
    const req = async (_m: string, p: string): Promise<unknown> => {
      if (p.endsWith('/usage')) throw new Error('404')
      return { currentSubscription: { status: 'active', spend: 5, maxBudget: 10 } }
    }
    expect((await fetchAiUsage(req))?.percent).toBe(50)
  })
  it('returns null on errors', async () => {
    expect(await fetchAiUsage(async () => { throw new Error('x') })).toBeNull()
  })
})
