/**
 * Subscription usage tracker.
 *
 * Receives usage signals from coding-agent adapters (cumulative token totals,
 * plan-limit snapshots and sparse updates), persists them through
 * `UsageStore`, and emits change events that agent-manager forwards to the
 * desktop renderer and mobile clients.
 */

import { EventEmitter } from 'events'
import type {
  ProviderUsageLimits,
  TokenUsageRecord,
  UsageLimitsRefreshResult,
  UsageProvider,
  UsageSummary,
  UsageSummaryQuery
} from '../../shared/usage'
import { mergeUsageLimits } from '../../shared/usage'
import type { AdapterUsageLimitsEvent, AdapterUsageReport } from '../adapters/coding-agent-adapter'
import type { UsageStore } from './usage-store'

/** Automatic refreshes (e.g. opening the Usage view) re-probe at most this often. */
export const AUTO_LIMITS_REFRESH_INTERVAL_MS = 5 * 60 * 1000
/** Even a manual refresh does not re-probe a provider more often than this. */
export const MANUAL_LIMITS_REFRESH_INTERVAL_MS = 15 * 1000

export type UsageLimitsProbe = () => Promise<ProviderUsageLimits | null>

export interface UsageTrackerEvents {
  recorded: (records: TokenUsageRecord[]) => void
  limits: (limits: ProviderUsageLimits) => void
}

export class UsageTracker extends EventEmitter {
  private limits = new Map<UsageProvider, ProviderUsageLimits>()
  private lastProbeAt = new Map<UsageProvider, number>()
  private inFlightProbes = new Map<UsageProvider, Promise<ProviderUsageLimits | null>>()

  constructor(private readonly store: UsageStore, private readonly now: () => number = Date.now) {
    super()
    for (const snapshot of store.getProviderUsageLimits()) {
      this.limits.set(snapshot.provider, snapshot)
    }
    try {
      store.prune(this.now())
    } catch (error) {
      console.warn('[UsageTracker] Failed to prune old usage rows:', error)
    }
  }

  override on<E extends keyof UsageTrackerEvents>(event: E, listener: UsageTrackerEvents[E]): this {
    return super.on(event, listener)
  }

  override emit<E extends keyof UsageTrackerEvents>(event: E, ...args: Parameters<UsageTrackerEvents[E]>): boolean {
    return super.emit(event, ...args)
  }

  /** Records usage from an adapter (cumulative or discrete). Returns the records written. */
  recordUsage(report: AdapterUsageReport): TokenUsageRecord[] {
    let records: TokenUsageRecord[] = []
    try {
      records = report.kind === 'discrete'
        ? this.store.recordDiscreteUsage({
          provider: report.provider,
          sessionId: report.providerSessionId || null,
          taskId: report.taskId || null,
          agentId: report.agentId || null,
          items: report.items.map((item) => ({ ...item, occurredAt: item.occurredAt ?? this.now() }))
        })
        : this.store.recordCumulativeUsage({
        provider: report.provider,
        sessionId: report.providerSessionId,
        taskId: report.taskId || null,
        agentId: report.agentId || null,
        newSession: report.newSession,
        buckets: report.buckets,
        observedAt: this.now()
      })
    } catch (error) {
      console.error('[UsageTracker] Failed to record token usage:', error)
      return []
    }
    if (records.length > 0) this.emit('recorded', records)
    return records
  }

  /** Applies a plan-limit event from an adapter (stream update or full snapshot). */
  applyLimitsEvent(event: AdapterUsageLimitsEvent): ProviderUsageLimits {
    if (event.kind === 'snapshot') return this.applySnapshot(event.limits)
    const previous = this.limits.get(event.provider)
    const merged = mergeUsageLimits(event.provider, previous, event.update, new Date(this.now()).toISOString())
    if (merged !== previous) this.commitLimits(merged)
    return merged
  }

  /** Allows the next refresh to probe `provider` immediately (e.g. after its auth settings changed). */
  clearProbeThrottle(provider: UsageProvider): void {
    this.lastProbeAt.delete(provider)
  }

  getLimits(): ProviderUsageLimits[] {
    return Array.from(this.limits.values()).sort((a, b) => a.provider.localeCompare(b.provider))
  }

  getSummary(query: UsageSummaryQuery = {}): UsageSummary {
    return this.store.getUsageSummary(query)
  }

  /**
   * Probes plan limits for the given providers. Throttled per provider, and
   * concurrent callers share one in-flight probe.
   */
  async refreshLimits(
    probes: Partial<Record<UsageProvider, UsageLimitsProbe>>,
    options: { force?: boolean } = {}
  ): Promise<UsageLimitsRefreshResult> {
    const minInterval = options.force ? MANUAL_LIMITS_REFRESH_INTERVAL_MS : AUTO_LIMITS_REFRESH_INTERVAL_MS
    const refreshed: UsageProvider[] = []

    await Promise.all(
      (Object.entries(probes) as Array<[UsageProvider, UsageLimitsProbe | undefined]>).map(async ([provider, probe]) => {
        if (!probe) return
        const existing = this.inFlightProbes.get(provider)
        if (existing) {
          await existing
          return
        }
        const last = this.lastProbeAt.get(provider) ?? 0
        if (this.now() - last < minInterval) return

        this.lastProbeAt.set(provider, this.now())
        const pending = probe()
          .then((limits) => {
            if (limits) this.applySnapshot({ ...limits, provider })
            return limits
          })
          .catch((error) => {
            console.warn(`[UsageTracker] ${provider} plan-limit probe failed:`, error)
            return this.applySnapshot({
              provider,
              checkedAt: new Date(this.now()).toISOString(),
              windows: [],
              unavailable: { reason: 'probe_failed', message: error instanceof Error ? error.message : String(error) }
            })
          })
          .finally(() => this.inFlightProbes.delete(provider))
        this.inFlightProbes.set(provider, pending)
        await pending
        refreshed.push(provider)
      })
    )

    return { limits: this.getLimits(), refreshed }
  }

  /**
   * A failed probe keeps the last known windows (marked as stale through
   * `unavailable.reason = 'probe_failed'`) instead of wiping them.
   */
  private applySnapshot(snapshot: ProviderUsageLimits): ProviderUsageLimits {
    const previous = this.limits.get(snapshot.provider)
    let next = snapshot
    if (snapshot.unavailable?.reason === 'probe_failed' && previous && previous.windows.length > 0) {
      next = { ...previous, unavailable: snapshot.unavailable }
    }
    this.commitLimits(next)
    return next
  }

  private commitLimits(limits: ProviderUsageLimits): void {
    this.limits.set(limits.provider, limits)
    try {
      this.store.saveProviderUsageLimits(limits)
    } catch (error) {
      console.warn('[UsageTracker] Failed to persist plan limits:', error)
    }
    this.emit('limits', limits)
  }
}
