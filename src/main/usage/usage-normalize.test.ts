import { describe, it, expect } from 'vitest'
import {
  claudeRateLimitInfoToUpdate,
  claudeUsageResponseToLimits,
  codexRateLimitsResponseToLimits,
  codexRateLimitsUpdatedToUpdate,
  computeUsageDelta,
  normalizeClaudeModelUsage,
  normalizeCodexThreadTokenUsage,
  type UsageTotals
} from './usage-normalize'

const CHECKED_AT = '2026-10-05T10:00:00.000Z'

function totals(partial: Partial<UsageTotals> = {}): UsageTotals {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: null,
    ...partial
  }
}

describe('normalizeClaudeModelUsage', () => {
  it('maps every model of result.modelUsage to a bucket', () => {
    const buckets = normalizeClaudeModelUsage({
      'claude-opus-4-7': {
        inputTokens: 120,
        outputTokens: 900,
        thinkingTokens: 300,
        cacheReadInputTokens: 50_000,
        cacheCreationInputTokens: 4_000,
        webSearchRequests: 0,
        costUSD: 1.25,
        contextWindow: 200_000,
        maxOutputTokens: 32_000
      },
      'claude-haiku-4-5': {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.001,
        contextWindow: 200_000,
        maxOutputTokens: 8_000
      }
    })

    expect(buckets).toEqual([
      {
        key: 'claude-opus-4-7',
        model: 'claude-opus-4-7',
        totals: {
          inputTokens: 120,
          cacheReadTokens: 50_000,
          cacheWriteTokens: 4_000,
          outputTokens: 900,
          reasoningTokens: 300,
          costUsd: 1.25
        }
      },
      {
        key: 'claude-haiku-4-5',
        model: 'claude-haiku-4-5',
        totals: {
          inputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 20,
          reasoningTokens: 0,
          costUsd: 0.001
        }
      }
    ])
  })

  it('ignores malformed payloads', () => {
    expect(normalizeClaudeModelUsage(undefined)).toEqual([])
    expect(normalizeClaudeModelUsage({ model: 'not-an-object' })).toEqual([])
  })

  it('never reports more reasoning than output tokens', () => {
    const [bucket] = normalizeClaudeModelUsage({ m: { outputTokens: 5, thinkingTokens: 50 } })
    expect(bucket.totals.reasoningTokens).toBe(5)
  })
})

describe('normalizeCodexThreadTokenUsage', () => {
  it('derives uncached input from Codex totals (input includes cached)', () => {
    const result = normalizeCodexThreadTokenUsage({
      threadId: 'thr_1',
      turnId: 'turn_1',
      tokenUsage: {
        total: {
          inputTokens: 10_000,
          cachedInputTokens: 7_000,
          cacheWriteInputTokens: 1_000,
          outputTokens: 800,
          reasoningOutputTokens: 300,
          totalTokens: 10_800
        },
        last: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 },
        modelContextWindow: 272_000
      }
    }, 'gpt-6-astra')

    expect(result).toEqual({
      bucket: {
        key: 'thread',
        model: 'gpt-6-astra',
        totals: {
          inputTokens: 2_000,
          cacheReadTokens: 7_000,
          cacheWriteTokens: 1_000,
          outputTokens: 800,
          reasoningTokens: 300,
          costUsd: null
        }
      },
      contextWindow: 272_000,
      turnId: 'turn_1'
    })
  })

  it('returns null without totals', () => {
    expect(normalizeCodexThreadTokenUsage({ tokenUsage: {} }, 'm')).toBeNull()
    expect(normalizeCodexThreadTokenUsage(null, 'm')).toBeNull()
  })
})

describe('computeUsageDelta', () => {
  it('returns the current totals when there is no previous reading', () => {
    expect(computeUsageDelta(undefined, totals({ inputTokens: 5, costUsd: 0.5 }))).toEqual({
      delta: totals({ inputTokens: 5, costUsd: 0.5 }),
      reset: false
    })
  })

  it('subtracts the previous cumulative totals', () => {
    const { delta, reset } = computeUsageDelta(
      totals({ inputTokens: 100, cacheReadTokens: 1_000, outputTokens: 50, costUsd: 1 }),
      totals({ inputTokens: 150, cacheReadTokens: 3_000, outputTokens: 80, costUsd: 1.4 })
    )
    expect(reset).toBe(false)
    expect(delta.inputTokens).toBe(50)
    expect(delta.cacheReadTokens).toBe(2_000)
    expect(delta.outputTokens).toBe(30)
    expect(delta.costUsd).toBeCloseTo(0.4)
  })

  it('treats a decreasing counter as a restarted running total', () => {
    const current = totals({ inputTokens: 10, outputTokens: 400 })
    expect(computeUsageDelta(totals({ inputTokens: 100, outputTokens: 50 }), current)).toEqual({
      delta: current,
      reset: true
    })
  })

  it('keeps cost unknown when the provider does not report it', () => {
    const { delta } = computeUsageDelta(totals({ outputTokens: 1 }), totals({ outputTokens: 9 }))
    expect(delta.costUsd).toBeNull()
  })
})

describe('Claude plan limits', () => {
  it('maps a streamed rate_limit_event (utilization is a 0–1 fraction)', () => {
    expect(claudeRateLimitInfoToUpdate({
      status: 'allowed_warning',
      rateLimitType: 'five_hour',
      utilization: 0.82,
      resetsAt: 1_791_200_000
    })).toEqual({
      windows: [{
        id: 'five_hour',
        kind: 'session',
        label: '5-hour',
        windowDurationMins: 300,
        usedPercent: 82,
        resetsAt: new Date(1_791_200_000 * 1000).toISOString()
      }],
      limitReached: false
    })
  })

  it('flags a rejected event even without a known window', () => {
    expect(claudeRateLimitInfoToUpdate({ status: 'rejected', rateLimitType: 'overage' })).toEqual({
      windows: [],
      limitReached: true
    })
    expect(claudeRateLimitInfoToUpdate({ status: 'allowed', rateLimitType: 'overage', utilization: 0.1 })).toBeNull()
  })

  it('maps the usage response (percentages already 0–100)', () => {
    const limits = claudeUsageResponseToLimits({
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 41, resets_at: '2026-10-05T12:00:00Z' },
        seven_day: { utilization: 12.5, resets_at: '2026-10-09T00:00:00Z' },
        seven_day_opus: null,
        model_scoped: [{ display_name: 'Fable', utilization: 3, resets_at: null }]
      }
    }, CHECKED_AT)

    expect(limits.provider).toBe('claude-code')
    expect(limits.planType).toBe('max')
    expect(limits.unavailable).toBeNull()
    expect(limits.windows.map((w) => [w.id, w.kind, w.usedPercent])).toEqual([
      ['five_hour', 'session', 41],
      ['seven_day', 'weekly', 12.5],
      ['seven_day_scoped:fable', 'weekly', 3]
    ])
    expect(limits.windows[0].resetsAt).toBe('2026-10-05T12:00:00.000Z')
  })

  it('reports unsupported for API-key and third-party auth', () => {
    const limits = claudeUsageResponseToLimits({ rate_limits_available: false, rate_limits: null, subscription_type: null }, CHECKED_AT)
    expect(limits.windows).toEqual([])
    expect(limits.unavailable?.reason).toBe('unsupported')
  })
})

describe('Codex plan limits', () => {
  const readResponse = {
    rateLimits: {
      limitId: 'codex',
      planType: 'pro',
      primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1_791_200_000 },
      secondary: { usedPercent: 64, windowDurationMins: 10_080, resetsAt: 1_791_600_000 },
      rateLimitReachedType: null
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        planType: 'pro',
        primary: { usedPercent: 38, windowDurationMins: 300, resetsAt: 1_791_200_000 },
        secondary: { usedPercent: 64, windowDurationMins: 10_080, resetsAt: 1_791_600_000 }
      },
      codex_spark: { limitId: 'codex_spark', primary: { usedPercent: 99 } }
    },
    rateLimitResetCredits: { availableCount: 2 }
  }

  it('prefers the codex bucket and maps both windows', () => {
    const limits = codexRateLimitsResponseToLimits(readResponse, CHECKED_AT)
    expect(limits.planType).toBe('pro')
    expect(limits.resetCreditsAvailable).toBe(2)
    expect(limits.limitReached).toBe(false)
    expect(limits.windows).toEqual([
      {
        id: 'primary',
        kind: 'session',
        label: '5-hour',
        usedPercent: 38,
        resetsAt: new Date(1_791_200_000 * 1000).toISOString(),
        windowDurationMins: 300
      },
      {
        id: 'secondary',
        kind: 'weekly',
        label: 'Weekly',
        usedPercent: 64,
        resetsAt: new Date(1_791_600_000 * 1000).toISOString(),
        windowDurationMins: 10_080
      }
    ])
  })

  it('falls back to a monthly primary window for free/go plans without durations', () => {
    const limits = codexRateLimitsResponseToLimits({
      rateLimits: { planType: 'free', primary: { usedPercent: 10 } }
    }, CHECKED_AT)
    expect(limits.windows[0]).toMatchObject({ id: 'primary', kind: 'monthly', label: 'Monthly', windowDurationMins: 43_200 })
  })

  it('ignores model-specific rolling updates', () => {
    expect(codexRateLimitsUpdatedToUpdate({ rateLimits: { limitId: 'codex_spark', primary: { usedPercent: 99 } } })).toBeNull()
  })

  it('maps a sparse rolling update', () => {
    expect(codexRateLimitsUpdatedToUpdate({
      rateLimits: { limitId: 'codex', primary: { usedPercent: 51, windowDurationMins: 300 }, rateLimitReachedType: 'rate_limit_reached' }
    })).toEqual({
      windows: [{ id: 'primary', kind: 'session', label: '5-hour', usedPercent: 51, resetsAt: null, windowDurationMins: 300 }],
      limitReached: true
    })
  })
})
