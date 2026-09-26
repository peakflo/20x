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

describe('parseAiUsage /usage contract', () => {
  const active = { active: true, planId: 'P', planName: 'Standard', usage: { usedUsd: 14.62, limitUsd: 20, percentUsed: 73, resetAt: '2026-10-21T00:00:00.000Z' } }
  it('reads nested usage', () => {
    expect(parseAiUsage(active)).toEqual({ percent: 73, used: 14.62, limit: 20, resetAt: '2026-10-21T00:00:00.000Z' })
  })
  it('hides when inactive or usage is null', () => {
    expect(parseAiUsage({ active: false, planId: null, planName: null, usage: null })).toBeNull()
    expect(parseAiUsage({ ...active, usage: null })).toBeNull()
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
  it('does not fall back to /plan when /usage says inactive', async () => {
    const paths: string[] = []
    const req = async (_m: string, p: string): Promise<unknown> => {
      paths.push(p)
      if (p.endsWith('/usage')) return { active: false, planId: null, planName: null, usage: null }
      return { currentSubscription: { status: 'active', spend: 5, maxBudget: 10 } }
    }
    expect(await fetchAiUsage(req)).toBeNull()
    expect(paths).toEqual(['/api/20x/ai-gateway/usage'])
  })
  it('does not fall back when active:true with usage:null', async () => {
    const req = async (_m: string, p: string): Promise<unknown> =>
      p.endsWith('/usage') ? { active: true, usage: null } : { currentSubscription: { status: 'active', spend: 5, maxBudget: 10 } }
    expect(await fetchAiUsage(req)).toBeNull()
  })
  it('uses /usage result when active', async () => {
    const req = async (): Promise<unknown> => ({ active: true, usage: { usedUsd: 1, limitUsd: 2, percentUsed: 50, resetAt: null } })
    expect((await fetchAiUsage(req))?.percent).toBe(50)
  })
  it('returns null on errors', async () => {
    expect(await fetchAiUsage(async () => { throw new Error('x') })).toBeNull()
  })
})
