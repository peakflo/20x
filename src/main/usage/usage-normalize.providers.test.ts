import { describe, it, expect } from 'vitest'
import {
  acpUsageUpdateCostUsd,
  cursorPeriodUsageToLimits,
  normalizeAcpPromptUsage,
  normalizeOpenCodeAssistantMessage,
  normalizePiSessionStats,
  openCodeGoUsageToLimits
} from './usage-normalize'

const CHECKED_AT = '2026-10-05T10:00:00.000Z'

describe('OpenCode', () => {
  const message = {
    id: 'msg_1',
    sessionID: 'ses_1',
    role: 'assistant',
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4-5',
    time: { created: 1_791_000_000_000, completed: 1_791_000_005_000 },
    cost: 0.12,
    tokens: { input: 40, output: 300, reasoning: 100, cache: { read: 9_000, write: 500 } }
  }

  it('maps a completed assistant message (reasoning counted inside output)', () => {
    expect(normalizeOpenCodeAssistantMessage(message)).toEqual({
      sourceKey: 'ses_1:msg_1',
      sessionId: 'ses_1',
      model: 'anthropic/claude-sonnet-4-5',
      usage: {
        inputTokens: 40,
        cacheReadTokens: 9_000,
        cacheWriteTokens: 500,
        outputTokens: 400,
        reasoningTokens: 100,
        costUsd: 0.12
      },
      createdAt: 1_791_000_000_000
    })
  })

  it('ignores in-progress and non-assistant messages', () => {
    expect(normalizeOpenCodeAssistantMessage({ ...message, time: { created: 1 } })).toBeNull()
    expect(normalizeOpenCodeAssistantMessage({ ...message, role: 'user' })).toBeNull()
  })

  it('treats a zero cost (unpriced / subscription model) as unknown', () => {
    expect(normalizeOpenCodeAssistantMessage({ ...message, cost: 0 })?.usage.costUsd).toBeNull()
  })

  it('maps OpenCode Go usage windows', () => {
    const limits = openCodeGoUsageToLimits({
      usage: {
        rolling: { percent: 22, resetsAt: '2026-10-05T14:00:00Z' },
        weekly: { percent: 48, resetsAt: '2026-10-09T00:00:00Z' },
        monthly: { percent: 120, resetsAt: '2026-11-01T00:00:00Z' }
      }
    }, CHECKED_AT)
    expect(limits).toMatchObject({ provider: 'opencode', planType: 'go', unavailable: null })
    expect(limits.windows.map((w) => [w.id, w.kind, w.usedPercent])).toEqual([
      ['go_rolling', 'session', 22],
      ['go_weekly', 'weekly', 48],
      ['go_monthly', 'monthly', 100]
    ])
  })
})

describe('Pi', () => {
  it('maps get_session_stats into one cumulative bucket', () => {
    expect(normalizePiSessionStats({
      sessionFile: '/x.jsonl',
      tokens: { input: 1_000, output: 200, cacheRead: 30_000, cacheWrite: 2_000, total: 33_200 },
      cost: 0.31
    }, 'anthropic/claude-opus-4-7')).toEqual({
      key: 'session',
      model: 'anthropic/claude-opus-4-7',
      totals: { inputTokens: 1_000, cacheReadTokens: 30_000, cacheWriteTokens: 2_000, outputTokens: 200, reasoningTokens: 0, costUsd: 0.31 }
    })
  })

  it('treats zero cost as unknown and rejects malformed stats', () => {
    expect(normalizePiSessionStats({ tokens: { input: 1, output: 1 }, cost: 0 }, 'm')?.totals.costUsd).toBeNull()
    expect(normalizePiSessionStats({}, 'm')).toBeNull()
  })
})

describe('Cursor (ACP)', () => {
  it('maps prompt usage with the cumulative usage_update cost', () => {
    expect(normalizeAcpPromptUsage(
      { totalTokens: 12_000, inputTokens: 2_000, outputTokens: 900, thoughtTokens: 300, cachedReadTokens: 9_000, cachedWriteTokens: 100 },
      'gpt-5',
      0.42
    )).toEqual({
      key: 'session',
      model: 'gpt-5',
      totals: { inputTokens: 2_000, cacheReadTokens: 9_000, cacheWriteTokens: 100, outputTokens: 900, reasoningTokens: 300, costUsd: 0.42 }
    })
  })

  it('keeps a cost-only reading and drops an empty one', () => {
    expect(normalizeAcpPromptUsage({ totalTokens: 0, inputTokens: 0, outputTokens: 0 }, 'auto', 1.5)?.totals.costUsd).toBe(1.5)
    expect(normalizeAcpPromptUsage({ totalTokens: 0, inputTokens: 0, outputTokens: 0 }, 'auto', null)).toBeNull()
    expect(normalizeAcpPromptUsage(undefined, 'auto', null)).toBeNull()
  })

  it('reads usage_update cost only when it is USD', () => {
    expect(acpUsageUpdateCostUsd({ sessionUpdate: 'usage_update', used: 1, size: 2, cost: { amount: 0.5, currency: 'usd' } })).toBe(0.5)
    expect(acpUsageUpdateCostUsd({ cost: { amount: 0.5, currency: 'EUR' } })).toBeNull()
    expect(acpUsageUpdateCostUsd({ used: 1, size: 2 })).toBeNull()
  })

  it('maps the current billing period usage', () => {
    const limits = cursorPeriodUsageToLimits({
      billingCycleEnd: '1789876386000',
      planUsage: { totalPercentUsed: 61.5, autoPercentUsed: 40, apiPercentUsed: 90 }
    }, CHECKED_AT)
    expect(limits.unavailable).toBeNull()
    expect(limits.windows.map((w) => [w.id, w.kind, w.usedPercent, w.resetsAt])).toEqual([
      ['total', 'monthly', 61.5, '2026-09-20T03:53:06.000Z'],
      ['auto', 'monthly', 40, '2026-09-20T03:53:06.000Z'],
      ['api', 'monthly', 90, '2026-09-20T03:53:06.000Z']
    ])
  })

  it('reports unsupported without plan usage', () => {
    expect(cursorPeriodUsageToLimits({}, CHECKED_AT).unavailable?.reason).toBe('unsupported')
  })
})
