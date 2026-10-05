/**
 * Subscription usage tracker.
 *
 * Receives usage signals from coding-agent adapters (cumulative token totals,
 * plan-limit snapshots and sparse updates), persists them through
 * `UsageStore`, and emits change events that agent-manager forwards to the
 * desktop renderer and mobile clients.
 *
 * Plan limits are kept per harness instance (one subscription login), so two
 * Codex accounts each have their own windows.
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
import { defaultHarnessInstanceId } from '../../shared/harness-instances'
import type { AdapterUsageLimitsEvent, AdapterUsageReport } from '../adapters/coding-agent-adapter'
import type { UsageStore } from './usage-store'

/** Automatic refreshes (e.g. opening the Usage view) re-probe at most this often. */
export const AUTO_LIMITS_REFRESH_INTERVAL_MS = 5 * 60 * 1000
/** Even a manual refresh does not re-probe an instance more often than this. */
export const MANUAL_LIMITS_REFRESH_INTERVAL_MS = 15 * 1000

export type UsageLimitsProbe = () => Promise<ProviderUsageLimits | null>

/** One harness instance to probe. */
export interface UsageLimitsProbeTarget {
  instanceId: string
  provider: UsageProvider
  probe: UsageLimitsProbe
}

/** Resolves the display label of an instance. Called on every read, so renames show at once. */
export type InstanceLabelResolver = (instanceId: string, provider: UsageProvider) => string

export interface UsageTrackerEvents {
  recorded: (records: TokenUsageRecord[]) => void
  limits: (limits: ProviderUsageLimits) => void
}

const DEFAULT_LABEL_RESOLVER: InstanceLabelResolver = (_instanceId, provider) => provider

export class UsageTracker extends EventEmitter {
  private limits = new Map<string, ProviderUsageLimits>()
  private lastProbeAt = new Map<string, number>()
  private inFlightProbes = new Map<string, Promise<ProviderUsageLimits | null>>()

  constructor(
    private readonly store: UsageStore,
    private readonly now: () => number = Date.now,
    private readonly labelFor: InstanceLabelResolver = DEFAULT_LABEL_RESOLVER
  ) {
    super()
    for (const snapshot of store.getProviderUsageLimits()) {
      const instanceId = snapshot.instanceId ?? defaultHarnessInstanceId(snapshot.provider)
      this.limits.set(instanceId, { ...snapshot, instanceId })
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
          instanceId: report.instanceId || null,
          items: report.items.map((item) => ({ ...item, occurredAt: item.occurredAt ?? this.now() }))
        })
        : this.store.recordCumulativeUsage({
        provider: report.provider,
        sessionId: report.providerSessionId,
        taskId: report.taskId || null,
        agentId: report.agentId || null,
        instanceId: report.instanceId || null,
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
    if (event.kind === 'snapshot') {
      return this.applySnapshot({ ...event.limits, instanceId: event.instanceId ?? event.limits.instanceId })
    }
    const instanceId = event.instanceId ?? defaultHarnessInstanceId(event.provider)
    const previous = this.limits.get(instanceId)
    const merged = mergeUsageLimits(event.provider, previous, event.update, new Date(this.now()).toISOString())
    const next = { ...merged, instanceId }
    if (merged !== previous) this.commitLimits(next)
    return next
  }

  /** Allows the next refresh to probe `instanceId` immediately (e.g. after its auth settings changed). */
  clearProbeThrottle(instanceId: string): void {
    this.lastProbeAt.delete(instanceId)
  }

  /** Plan limits of every instance, labelled with the instance's current name. */
  getLimits(): ProviderUsageLimits[] {
    return Array.from(this.limits.values())
      .map((limits) => this.withLabel(limits))
      .sort((a, b) => a.provider.localeCompare(b.provider) || (a.instanceId ?? '').localeCompare(b.instanceId ?? ''))
  }

  getSummary(query: UsageSummaryQuery = {}): UsageSummary {
    return this.store.getUsageSummary(query)
  }

  /**
   * Probes plan limits for the given harness instances. Throttled per instance,
   * and concurrent callers share one in-flight probe.
   */
  async refreshLimits(
    targets: UsageLimitsProbeTarget[],
    options: { force?: boolean } = {}
  ): Promise<UsageLimitsRefreshResult> {
    const minInterval = options.force ? MANUAL_LIMITS_REFRESH_INTERVAL_MS : AUTO_LIMITS_REFRESH_INTERVAL_MS
    const refreshed: string[] = []

    await Promise.all(
      targets.map(async ({ instanceId, provider, probe }) => {
        const existing = this.inFlightProbes.get(instanceId)
        if (existing) {
          await existing
          return
        }
        const last = this.lastProbeAt.get(instanceId) ?? 0
        if (this.now() - last < minInterval) return

        this.lastProbeAt.set(instanceId, this.now())
        const pending = probe()
          .then((limits) => {
            if (limits) this.applySnapshot({ ...limits, provider, instanceId })
            return limits
          })
          .catch((error) => {
            console.warn(`[UsageTracker] ${provider} plan-limit probe failed for ${instanceId}:`, error)
            return this.applySnapshot({
              provider,
              instanceId,
              checkedAt: new Date(this.now()).toISOString(),
              windows: [],
              unavailable: { reason: 'probe_failed', message: error instanceof Error ? error.message : String(error) }
            })
          })
          .finally(() => this.inFlightProbes.delete(instanceId))
        this.inFlightProbes.set(instanceId, pending)
        await pending
        refreshed.push(instanceId)
      })
    )

    return { limits: this.getLimits(), refreshed }
  }

  /**
   * A failed probe keeps the last known windows (marked as stale through
   * `unavailable.reason = 'probe_failed'`) instead of wiping them.
   */
  private applySnapshot(snapshot: ProviderUsageLimits): ProviderUsageLimits {
    const instanceId = snapshot.instanceId ?? defaultHarnessInstanceId(snapshot.provider)
    const previous = this.limits.get(instanceId)
    let next: ProviderUsageLimits = { ...snapshot, instanceId }
    if (snapshot.unavailable?.reason === 'probe_failed' && previous && previous.windows.length > 0) {
      next = { ...previous, instanceId, unavailable: snapshot.unavailable }
    }
    this.commitLimits(next)
    return next
  }

  private commitLimits(limits: ProviderUsageLimits): void {
    const instanceId = limits.instanceId ?? defaultHarnessInstanceId(limits.provider)
    this.limits.set(instanceId, limits)
    try {
      this.store.saveProviderUsageLimits({ ...limits, instanceId })
    } catch (error) {
      console.warn('[UsageTracker] Failed to persist plan limits:', error)
    }
    this.emit('limits', this.withLabel(limits))
  }

  private withLabel(limits: ProviderUsageLimits): ProviderUsageLimits {
    const instanceId = limits.instanceId ?? defaultHarnessInstanceId(limits.provider)
    return { ...limits, instanceId, instanceLabel: this.labelFor(instanceId, limits.provider) }
  }
}
