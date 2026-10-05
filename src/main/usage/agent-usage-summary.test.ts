import { describe, it, expect } from 'vitest'
import { limitsByProvider, summarizeAgentUsage } from './agent-usage-summary'
import type { ProviderUsageLimits } from '../../shared/usage'

const NOW = Date.parse('2026-10-05T10:00:00Z')

const claude: ProviderUsageLimits = {
  provider: 'claude-code',
  checkedAt: '2026-10-05T09:55:00Z',
  planType: 'max',
  windows: [
    { id: 'five_hour', kind: 'session', label: '5-hour', usedPercent: 40, resetsAt: '2026-10-05T12:00:00Z' },
    { id: 'seven_day', kind: 'weekly', label: 'Weekly', usedPercent: 92, resetsAt: '2026-10-09T00:00:00Z' }
  ]
}

const codex: ProviderUsageLimits = {
  provider: 'codex',
  checkedAt: '2026-10-05T09:58:00Z',
  windows: [
    // Reset already passed: counts as unused.
    { id: 'primary', kind: 'session', label: '5-hour', usedPercent: 100, resetsAt: '2026-10-05T09:00:00Z' },
    { id: 'secondary', kind: 'weekly', label: 'Weekly', usedPercent: 30, resetsAt: '2026-10-08T00:00:00Z' }
  ]
}

const byProvider = limitsByProvider([claude, codex])

describe('summarizeAgentUsage', () => {
  it('reports the busiest window and its level', () => {
    expect(summarizeAgentUsage({ config: { coding_agent: 'claude-code' } }, byProvider, NOW)).toMatchObject({
      level: 'critical',
      most_used_percent: 92,
      headroom_percent: 8,
      plan_type: 'max',
      windows: [
        { label: '5-hour', used_percent: 40, resets_at: '2026-10-05T12:00:00Z' },
        { label: 'Weekly', used_percent: 92, resets_at: '2026-10-09T00:00:00Z' }
      ],
      note: '92% of the weekly window used.'
    })
  })

  it('treats windows whose reset has passed as unused', () => {
    expect(summarizeAgentUsage({ config: { coding_agent: 'codex' } }, byProvider, NOW)).toMatchObject({
      level: 'low',
      most_used_percent: 30,
      headroom_percent: 70
    })
  })

  it('flags an exhausted harness', () => {
    const blocked = limitsByProvider([{ ...codex, limitReached: true, windows: [{ ...codex.windows[1], usedPercent: 100 }] }])
    const summary = summarizeAgentUsage({ config: { coding_agent: 'codex' } }, blocked, NOW)
    expect(summary.level).toBe('exhausted')
    expect(summary.note).toMatch(/^Limit reached; resets 2026-10-08/)
  })

  it('separates API-key agents, unknown readings and harnesses without limits', () => {
    expect(summarizeAgentUsage({ config: { coding_agent: 'claude-code', auth_method: 'api_key' } }, byProvider, NOW).level).toBe('not_applicable')
    expect(summarizeAgentUsage({ config: { coding_agent: 'pi' } }, byProvider, NOW)).toMatchObject({ level: 'unknown', most_used_percent: null })
    expect(summarizeAgentUsage({ config: { coding_agent: 'opencode' } }, limitsByProvider([{ provider: 'opencode', checkedAt: 'x', windows: [], unavailable: { reason: 'unsupported', message: 'No Go plan' } }]), NOW))
      .toMatchObject({ level: 'unknown', note: 'No Go plan' })
    expect(summarizeAgentUsage({ config: {} }, byProvider, NOW).level).toBe('unknown')
  })
})
