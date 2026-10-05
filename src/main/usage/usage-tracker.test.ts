import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { UsageStore } from './usage-store'
import { UsageTracker } from './usage-tracker'
import type { ProviderUsageLimits } from '../../shared/usage'

let now = Date.UTC(2026, 9, 5, 12, 0, 0)
let store: UsageStore
let tracker: UsageTracker

function claudeLimits(usedPercent: number): ProviderUsageLimits {
  return {
    provider: 'claude-code',
    checkedAt: new Date(now).toISOString(),
    planType: 'max',
    windows: [
      { id: 'five_hour', kind: 'session', label: '5-hour', usedPercent, resetsAt: '2026-10-05T15:00:00.000Z', windowDurationMins: 300 },
      { id: 'seven_day', kind: 'weekly', label: 'Weekly', usedPercent: 20, resetsAt: '2026-10-09T00:00:00.000Z', windowDurationMins: 10_080 }
    ],
    unavailable: null
  }
}

beforeEach(() => {
  now = Date.UTC(2026, 9, 5, 12, 0, 0)
  store = new UsageStore(new Database(':memory:'))
  tracker = new UsageTracker(store, () => now)
})

describe('UsageTracker', () => {
  it('records usage and emits the per-turn records', () => {
    const recorded = vi.fn()
    tracker.on('recorded', recorded)
    tracker.recordUsage({
      provider: 'codex',
      providerSessionId: 'thr',
      taskId: 't1',
      agentId: 'a1',
      newSession: true,
      buckets: [{ key: 'thread', model: 'gpt', totals: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: 0, costUsd: null } }]
    })
    expect(recorded).toHaveBeenCalledTimes(1)
    expect(recorded.mock.calls[0][0][0]).toMatchObject({ provider: 'codex', taskId: 't1', inputTokens: 10, costSource: 'unavailable' })
  })

  it('merges streamed updates into the last snapshot and persists them', () => {
    const emitted = vi.fn()
    tracker.on('limits', emitted)
    tracker.applyLimitsEvent({ kind: 'snapshot', limits: claudeLimits(40) })
    tracker.applyLimitsEvent({
      kind: 'update',
      provider: 'claude-code',
      update: { windows: [{ id: 'five_hour', kind: 'session', label: '5-hour', usedPercent: 55 }] }
    })

    const [limits] = tracker.getLimits()
    expect(limits.windows.find((w) => w.id === 'five_hour')).toMatchObject({
      usedPercent: 55,
      // Kept from the snapshot because the update did not carry it.
      resetsAt: '2026-10-05T15:00:00.000Z'
    })
    expect(limits.windows.find((w) => w.id === 'seven_day')?.usedPercent).toBe(20)
    expect(emitted).toHaveBeenCalledTimes(2)

    // Survives a restart.
    const reloaded = new UsageTracker(store, () => now)
    expect(reloaded.getLimits()[0].windows.find((w) => w.id === 'five_hour')?.usedPercent).toBe(55)
  })

  it('does not emit when an update changes nothing', () => {
    tracker.applyLimitsEvent({ kind: 'snapshot', limits: claudeLimits(40) })
    const emitted = vi.fn()
    tracker.on('limits', emitted)
    tracker.applyLimitsEvent({
      kind: 'update',
      provider: 'claude-code',
      update: { windows: [{ id: 'five_hour', kind: 'session', label: '5-hour', usedPercent: 40 }] }
    })
    expect(emitted).not.toHaveBeenCalled()
  })

  it('keeps the last known windows when a probe fails', async () => {
    tracker.applyLimitsEvent({ kind: 'snapshot', limits: claudeLimits(40) })
    now += 10 * 60 * 1000
    await tracker.refreshLimits([{
      instanceId: 'default:claude-code',
      provider: 'claude-code',
      probe: async () => ({
        provider: 'claude-code',
        checkedAt: new Date(now).toISOString(),
        windows: [],
        unavailable: { reason: 'probe_failed', message: 'offline' }
      })
    }])
    const [limits] = tracker.getLimits()
    expect(limits.windows).toHaveLength(2)
    expect(limits.unavailable).toEqual({ reason: 'probe_failed', message: 'offline' })
  })

  it('throttles automatic refreshes and shares in-flight probes', async () => {
    const probe = vi.fn(async () => claudeLimits(10))
    const target = { instanceId: 'default:claude-code', provider: 'claude-code' as const, probe }
    const [first, second] = await Promise.all([
      tracker.refreshLimits([target]),
      tracker.refreshLimits([target])
    ])
    expect(probe).toHaveBeenCalledTimes(1)
    expect(first.refreshed).toEqual(['default:claude-code'])
    expect(second.refreshed).toEqual([])

    now += 60 * 1000
    await tracker.refreshLimits([target])
    expect(probe).toHaveBeenCalledTimes(1)

    // A manual refresh is allowed sooner.
    await tracker.refreshLimits([target], { force: true })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('turns a throwing probe into a probe_failed snapshot', async () => {
    await tracker.refreshLimits([{
      instanceId: 'default:codex',
      provider: 'codex',
      probe: async () => { throw new Error('codex not installed') }
    }])
    expect(tracker.getLimits()).toEqual([
      expect.objectContaining({ provider: 'codex', instanceId: 'default:codex', unavailable: { reason: 'probe_failed', message: 'codex not installed' } })
    ])
  })

  it('keeps plan limits of two instances of one harness apart', async () => {
    const labels: Record<string, string> = { 'hi_work': 'Codex · Work', 'hi_personal': 'Codex · Personal' }
    tracker = new UsageTracker(store, () => now, (instanceId) => labels[instanceId] ?? 'Codex')
    const codex = (usedPercent: number): ProviderUsageLimits => ({
      provider: 'codex',
      checkedAt: new Date(now).toISOString(),
      windows: [{ id: 'primary', kind: 'session', label: '5-hour', usedPercent, resetsAt: null }],
      unavailable: null
    })
    await tracker.refreshLimits([
      { instanceId: 'hi_work', provider: 'codex', probe: async () => codex(85) },
      { instanceId: 'hi_personal', provider: 'codex', probe: async () => codex(12) }
    ])
    const limits = tracker.getLimits()
    expect(limits.map((l) => [l.instanceId, l.instanceLabel, l.windows[0].usedPercent])).toEqual([
      ['hi_personal', 'Codex · Personal', 12],
      ['hi_work', 'Codex · Work', 85]
    ])
    // Labels are read at each read, so a rename shows at once.
    labels.hi_work = 'Codex · Team'
    expect(tracker.getLimits().find((l) => l.instanceId === 'hi_work')?.instanceLabel).toBe('Codex · Team')
    // Both survive a restart of the tracker.
    const restarted = new UsageTracker(store, () => now)
    expect(restarted.getLimits().map((l) => l.instanceId)).toEqual(['hi_personal', 'hi_work'])
  })

  it('moves plan limits saved before instances existed to the default instance', () => {
    const legacy = new Database(':memory:')
    legacy.exec(`
      CREATE TABLE provider_usage_limits (provider TEXT PRIMARY KEY, snapshot TEXT NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO provider_usage_limits (provider, snapshot, updated_at) VALUES ('codex', '{"provider":"codex","checkedAt":"2026-10-05T11:00:00Z","windows":[]}', 1);
    `)
    const migrated = new UsageStore(legacy)
    expect(migrated.getProviderUsageLimits()).toEqual([
      expect.objectContaining({ provider: 'codex', instanceId: 'default:codex' })
    ])
    // The legacy table is gone, and a second open is a no-op.
    expect(new UsageStore(legacy).getProviderUsageLimits()).toHaveLength(1)
  })
})
