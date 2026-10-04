/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  AbortError: class AbortError extends Error {}
}))
vi.mock('child_process', () => ({ execFile: vi.fn() }))
vi.mock('fs', () => ({ existsSync: vi.fn(() => false) }))

import { ClaudeCodeAdapter } from './claude-code-adapter'
import type { AdapterUsageLimitsEvent, AdapterCumulativeUsageReport as AdapterUsageReport } from './coding-agent-adapter'

function fakeQuery(messages: unknown[], usageResponse?: unknown) {
  const queue = [...messages]
  return {
    [Symbol.asyncIterator]() { return this },
    async next() {
      const value = queue.shift()
      return value === undefined ? { done: true, value: undefined } : { done: false, value }
    },
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async () => usageResponse)
  }
}

function setup(messages: unknown[], opts: { createdInApp?: boolean; usageResponse?: unknown } = {}) {
  const adapter = new ClaudeCodeAdapter()
  const query = fakeQuery(messages, opts.usageResponse)
  const session: any = {
    sessionId: 'claude-session-1',
    queryIterator: query,
    abortController: null,
    status: 'busy',
    messageBuffer: [],
    messageCursor: 0,
    streamTask: null,
    lastError: null,
    config: { taskId: 'task-1', agentId: 'agent-1', workspaceDir: '/tmp' },
    createdInApp: opts.createdInApp ?? true,
    backgroundTasks: new Map(),
    sawResult: false,
    enqueuePrompt: null,
    releasePrompt: null
  }
  ;(adapter as any).sessions.set('claude-session-1', session)
  const reports: AdapterUsageReport[] = []
  const limitEvents: AdapterUsageLimitsEvent[] = []
  adapter.onUsage = (report) => reports.push(report as AdapterUsageReport)
  adapter.onUsageLimits = (event) => limitEvents.push(event)
  return { adapter, session, query, reports, limitEvents }
}

const successResult = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  session_id: 'claude-session-1',
  uuid: 'r1',
  total_cost_usd: 0.42,
  usage: { input_tokens: 3, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
  modelUsage: {
    'claude-opus-4-7': {
      inputTokens: 30,
      outputTokens: 400,
      thinkingTokens: 100,
      cacheReadInputTokens: 9_000,
      cacheCreationInputTokens: 700,
      webSearchRequests: 0,
      costUSD: 0.4,
      contextWindow: 200_000,
      maxOutputTokens: 32_000
    },
    'claude-haiku-4-5': {
      inputTokens: 5,
      outputTokens: 6,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.02,
      contextWindow: 200_000,
      maxOutputTokens: 8_000
    }
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('ClaudeCodeAdapter usage tracking', () => {
  it('reports cumulative per-model usage from result messages', async () => {
    const { adapter, session, reports } = setup([successResult])
    await (adapter as any).consumeStream('claude-session-1', session)

    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      provider: 'claude-code',
      providerSessionId: 'claude-session-1',
      taskId: 'task-1',
      agentId: 'agent-1',
      newSession: true
    })
    expect(reports[0].buckets.map((b) => [b.model, b.totals.outputTokens, b.totals.costUsd])).toEqual([
      ['claude-opus-4-7', 400, 0.4],
      ['claude-haiku-4-5', 6, 0.02]
    ])
  })

  it('marks usage from resumed sessions so history is not attributed to this turn', async () => {
    const { adapter, session, reports } = setup([successResult], { createdInApp: false })
    await (adapter as any).consumeStream('claude-session-1', session)
    expect(reports[0].newSession).toBe(false)
  })

  it('reports usage from error results too (failed turns still consume tokens)', async () => {
    const { adapter, session, reports } = setup([{ ...successResult, subtype: 'error_max_turns', is_error: true, errors: ['max turns'] }])
    await (adapter as any).consumeStream('claude-session-1', session)
    expect(reports).toHaveLength(1)
  })

  it('forwards streamed rate_limit_event updates', async () => {
    const { adapter, session, limitEvents } = setup([{
      type: 'rate_limit_event',
      uuid: 'rl1',
      session_id: 'claude-session-1',
      rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.9, resetsAt: 1_791_600_000 }
    }])
    await (adapter as any).consumeStream('claude-session-1', session)

    expect(limitEvents).toEqual([
      {
        kind: 'update',
        provider: 'claude-code',
        update: {
          windows: [{
            id: 'seven_day',
            kind: 'weekly',
            label: 'Weekly',
            windowDurationMins: 10_080,
            usedPercent: 90,
            resetsAt: new Date(1_791_600_000 * 1000).toISOString()
          }],
          limitReached: false
        }
      }
    ])
    // Not a transcript message.
    const parts = await adapter.pollMessages('claude-session-1', new Set(), new Set(), new Map(), {} as any)
    expect(parts).toEqual([])
  })

  it('refreshes the full plan-limit snapshot after a completed turn (throttled)', async () => {
    const usageResponse = {
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 33, resets_at: '2026-10-05T15:00:00Z' },
        seven_day: { utilization: 61, resets_at: '2026-10-09T00:00:00Z' }
      }
    }
    const { adapter, session, query, limitEvents } = setup([successResult, { ...successResult, uuid: 'r2' }], { usageResponse })
    await (adapter as any).consumeStream('claude-session-1', session)
    await flush()

    expect(query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET).toHaveBeenCalledTimes(1)
    expect(query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET).toHaveBeenCalledWith({ skipBehaviors: true })
    const snapshot = limitEvents.find((e) => e.kind === 'snapshot')
    expect(snapshot).toMatchObject({
      kind: 'snapshot',
      limits: {
        provider: 'claude-code',
        planType: 'max',
        windows: [
          { id: 'five_hour', usedPercent: 33 },
          { id: 'seven_day', usedPercent: 61 }
        ]
      }
    })
  })

  it('probes plan limits through a live query', async () => {
    const usageResponse = { subscription_type: null, rate_limits_available: false, rate_limits: null }
    const { adapter } = setup([], { usageResponse })
    const limits = await adapter.probeUsageLimits()
    expect(limits).toMatchObject({ provider: 'claude-code', unavailable: { reason: 'unsupported' } })
  })

  it('degrades to probe_failed when the SDK does not expose plan usage', async () => {
    const { adapter, query } = setup([])
    delete (query as any).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    const limits = await adapter.probeUsageLimits()
    expect(limits?.unavailable?.reason).toBe('probe_failed')
  })
})
