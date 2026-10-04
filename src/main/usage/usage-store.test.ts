import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { UsageStore } from './usage-store'
import type { UsageBucket, UsageTotals } from './usage-normalize'

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

function bucket(model: string, partial: Partial<UsageTotals>): UsageBucket {
  return { key: model, model, totals: totals(partial) }
}

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0)

let raw: InstanceType<typeof Database>
let store: UsageStore

beforeEach(() => {
  raw = new Database(':memory:')
  raw.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT)')
  store = new UsageStore(raw)
})

describe('UsageStore.recordCumulativeUsage', () => {
  it('stores per-turn deltas from cumulative totals', () => {
    const first = store.recordCumulativeUsage({
      provider: 'claude-code',
      sessionId: 's1',
      taskId: 't1',
      agentId: 'a1',
      newSession: true,
      buckets: [bucket('claude-opus-4-7', { inputTokens: 100, outputTokens: 50, costUsd: 0.5 })],
      observedAt: NOW
    })
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ inputTokens: 100, outputTokens: 50, costUsd: 0.5, costSource: 'reported', taskId: 't1' })

    const second = store.recordCumulativeUsage({
      provider: 'claude-code',
      sessionId: 's1',
      taskId: 't1',
      newSession: true,
      buckets: [bucket('claude-opus-4-7', { inputTokens: 160, outputTokens: 90, costUsd: 0.8 })],
      observedAt: NOW + 1000
    })
    expect(second).toHaveLength(1)
    expect(second[0].inputTokens).toBe(60)
    expect(second[0].outputTokens).toBe(40)
    expect(second[0].costUsd).toBeCloseTo(0.3)
  })

  it('records nothing when the totals did not move', () => {
    const input = {
      provider: 'codex' as const,
      sessionId: 'thr',
      newSession: true,
      buckets: [bucket('gpt', { inputTokens: 10, outputTokens: 5 })],
      observedAt: NOW
    }
    expect(store.recordCumulativeUsage(input)).toHaveLength(1)
    expect(store.recordCumulativeUsage(input)).toHaveLength(0)
  })

  it('only establishes a baseline for a resumed session it has never seen', () => {
    const history = store.recordCumulativeUsage({
      provider: 'claude-code',
      sessionId: 'old-session',
      newSession: false,
      buckets: [bucket('m', { inputTokens: 1_000_000, outputTokens: 500_000, costUsd: 120 })],
      observedAt: NOW
    })
    expect(history).toEqual([])

    const nextTurn = store.recordCumulativeUsage({
      provider: 'claude-code',
      sessionId: 'old-session',
      newSession: false,
      buckets: [bucket('m', { inputTokens: 1_000_100, outputTokens: 500_010, costUsd: 120.05 })],
      observedAt: NOW + 1
    })
    expect(nextTurn).toHaveLength(1)
    expect(nextTurn[0].inputTokens).toBe(100)
    expect(nextTurn[0].outputTokens).toBe(10)
  })

  it('counts a new model in a known session in full', () => {
    store.recordCumulativeUsage({
      provider: 'claude-code', sessionId: 's', newSession: false,
      buckets: [bucket('main', { outputTokens: 10 })], observedAt: NOW
    })
    const records = store.recordCumulativeUsage({
      provider: 'claude-code', sessionId: 's', newSession: false,
      buckets: [bucket('main', { outputTokens: 10 }), bucket('subagent', { outputTokens: 7 })], observedAt: NOW + 1
    })
    expect(records.map((r) => [r.model, r.outputTokens])).toEqual([['subagent', 7]])
  })

  it('ignores zeroed totals so the next real reading is not double-counted', () => {
    store.recordCumulativeUsage({
      provider: 'claude-code', sessionId: 's', newSession: true,
      buckets: [bucket('m', { outputTokens: 100 })], observedAt: NOW
    })
    expect(store.recordCumulativeUsage({
      provider: 'claude-code', sessionId: 's', newSession: true,
      buckets: [bucket('m', {})], observedAt: NOW + 1
    })).toEqual([])
    const records = store.recordCumulativeUsage({
      provider: 'claude-code', sessionId: 's', newSession: true,
      buckets: [bucket('m', { outputTokens: 130 })], observedAt: NOW + 2
    })
    expect(records[0].outputTokens).toBe(30)
  })

  it('keeps sessions of different providers apart', () => {
    store.recordCumulativeUsage({ provider: 'claude-code', sessionId: 'same', newSession: true, buckets: [bucket('m', { outputTokens: 5 })], observedAt: NOW })
    const codex = store.recordCumulativeUsage({ provider: 'codex', sessionId: 'same', newSession: true, buckets: [bucket('m', { outputTokens: 5 })], observedAt: NOW })
    expect(codex).toHaveLength(1)
  })
})

describe('UsageStore.recordDiscreteUsage', () => {
  const item = (sourceKey: string, partial: Partial<UsageTotals>) => ({ sourceKey, model: 'anthropic/claude-sonnet-4-5', usage: totals(partial), occurredAt: NOW })

  it('stores each source key once per provider', () => {
    const first = store.recordDiscreteUsage({
      provider: 'opencode', sessionId: 'ses', taskId: 't1', agentId: 'a1',
      items: [item('ses:m1', { inputTokens: 10, outputTokens: 5, costUsd: 0.01 }), item('ses:m2', { outputTokens: 3 })]
    })
    expect(first.map((r) => [r.model, r.outputTokens, r.costSource])).toEqual([
      ['anthropic/claude-sonnet-4-5', 5, 'reported'],
      ['anthropic/claude-sonnet-4-5', 3, 'unavailable']
    ])
    // Repeated events / reconcile passes are ignored.
    expect(store.recordDiscreteUsage({ provider: 'opencode', items: [item('ses:m1', { inputTokens: 10, outputTokens: 5 })] })).toEqual([])
    // The same key from another provider is a different item.
    expect(store.recordDiscreteUsage({ provider: 'pi', items: [item('ses:m1', { outputTokens: 1 })] })).toHaveLength(1)
  })

  it('skips empty items but keeps cost-only ones', () => {
    expect(store.recordDiscreteUsage({ provider: 'cursor', items: [item('k1', {})] })).toEqual([])
    expect(store.recordDiscreteUsage({ provider: 'cursor', items: [item('k2', { costUsd: 0.2 })] })).toHaveLength(1)
  })

  it('adds the source_key column to tables from an earlier build', () => {
    const legacy = new Database(':memory:')
    legacy.exec(`CREATE TABLE token_usage_events (
      id TEXT PRIMARY KEY, task_id TEXT, agent_id TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, session_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL,
      cost_source TEXT NOT NULL DEFAULT 'unavailable', created_at INTEGER NOT NULL)`)
    const upgraded = new UsageStore(legacy)
    expect(upgraded.recordDiscreteUsage({ provider: 'pi', items: [item('x', { outputTokens: 1 })] })).toHaveLength(1)
  })
})

describe('UsageStore.getUsageSummary', () => {
  beforeEach(() => {
    raw.prepare('INSERT INTO tasks (id, title) VALUES (?, ?)').run('t1', 'Fix login')
    store.recordCumulativeUsage({
      provider: 'claude-code', sessionId: 's1', taskId: 't1', newSession: true,
      buckets: [bucket('claude-opus-4-7', { inputTokens: 100, cacheReadTokens: 900, outputTokens: 200, costUsd: 2 })],
      observedAt: NOW - DAY
    })
    store.recordCumulativeUsage({
      provider: 'codex', sessionId: 'thr', taskId: 't2', newSession: true,
      buckets: [bucket('gpt-6-astra', { inputTokens: 50, outputTokens: 25 })],
      observedAt: NOW
    })
    store.recordCumulativeUsage({
      provider: 'codex', sessionId: 'old', newSession: true,
      buckets: [bucket('gpt-6-astra', { inputTokens: 1, outputTokens: 1 })],
      observedAt: NOW - 30 * DAY
    })
  })

  it('aggregates totals, providers, models, days and tasks within the range', () => {
    const summary = store.getUsageSummary({ sinceMs: NOW - 7 * DAY, untilMs: NOW + 1, utcOffsetMinutes: 0 })

    expect(summary.totals).toMatchObject({
      inputTokens: 150,
      cacheReadTokens: 900,
      outputTokens: 225,
      costUsd: 2,
      records: 2,
      unpricedRecords: 1
    })
    expect(summary.byProvider.map((p) => [p.provider, p.records])).toEqual([['claude-code', 1], ['codex', 1]])
    expect(summary.byModel[0]).toMatchObject({ provider: 'claude-code', model: 'claude-opus-4-7' })
    expect(summary.byDay.map((d) => d.day)).toEqual(['2026-10-04', '2026-10-05'])
    expect(summary.topTasks.map((t) => [t.taskId, t.title])).toEqual([['t1', 'Fix login'], ['t2', null]])
  })

  it('filters by task', () => {
    const summary = store.getUsageSummary({ sinceMs: NOW - 7 * DAY, untilMs: NOW + 1, taskId: 't2' })
    expect(summary.totals.records).toBe(1)
    expect(summary.totals.costUsd).toBeNull()
  })

  it('buckets days in the requested UTC offset', () => {
    // NOW - DAY = 2026-10-04T12:00Z → still the 4th at UTC+11; NOW → 23:00 on the 5th.
    const summary = store.getUsageSummary({ sinceMs: NOW - 7 * DAY, untilMs: NOW + 1, utcOffsetMinutes: 11 * 60 })
    expect(summary.byDay.map((d) => d.day)).toEqual(['2026-10-04', '2026-10-05'])
    const shifted = store.getUsageSummary({ sinceMs: NOW - 7 * DAY, untilMs: NOW + 1, utcOffsetMinutes: 13 * 60 })
    expect(shifted.byDay.map((d) => d.day)).toEqual(['2026-10-05', '2026-10-06'])
  })
})

describe('UsageStore plan limits + pruning', () => {
  it('round-trips provider limits', () => {
    store.saveProviderUsageLimits({
      provider: 'codex',
      checkedAt: '2026-10-05T00:00:00.000Z',
      windows: [{ id: 'primary', kind: 'session', label: '5-hour', usedPercent: 10 }]
    })
    expect(store.getProviderUsageLimits()).toEqual([
      {
        provider: 'codex',
        checkedAt: '2026-10-05T00:00:00.000Z',
        windows: [{ id: 'primary', kind: 'session', label: '5-hour', usedPercent: 10 }]
      }
    ])
  })

  it('prunes stale session totals and events older than a year', () => {
    store.recordCumulativeUsage({ provider: 'codex', sessionId: 'old', newSession: true, buckets: [bucket('m', { outputTokens: 1 })], observedAt: NOW - 400 * DAY })
    store.recordCumulativeUsage({ provider: 'codex', sessionId: 'new', newSession: true, buckets: [bucket('m', { outputTokens: 1 })], observedAt: NOW })
    store.prune(NOW)
    expect(store.getUsageEvents({ sinceMs: 0, untilMs: NOW + 1 }).map((e) => e.sessionId)).toEqual(['new'])
    const remaining = raw.prepare('SELECT session_id FROM token_usage_session_totals').all() as Array<{ session_id: string }>
    expect(remaining.map((r) => r.session_id)).toEqual(['new'])
  })
})
