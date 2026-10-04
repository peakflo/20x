import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { onEvent } from '../api/websocket'
import {
  USAGE_LIMITS_UPDATED_CHANNEL,
  USAGE_PROVIDER_LABELS,
  USAGE_RECORDED_CHANNEL,
  effectiveUsedPercent,
  formatResetIn,
  formatTokenCount,
  formatUsd,
  totalTokens,
  usageLimitLevel,
  usageSummaryQueryForPeriod,
  type ProviderUsageLimits,
  type UsageSummary
} from '@shared/usage'

const LEVEL_BAR = {
  normal: 'bg-primary',
  warning: 'bg-amber-500',
  critical: 'bg-destructive'
} as const

function upsert(list: ProviderUsageLimits[], next: ProviderUsageLimits): ProviderUsageLimits[] {
  return [...list.filter((l) => l.provider !== next.provider), next].sort((a, b) => a.provider.localeCompare(b.provider))
}

/** Subscription plan limits + 7-day token usage, for the mobile Settings page. */
export function SubscriptionUsageSection() {
  const [limits, setLimits] = useState<ProviderUsageLimits[]>([])
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const loadSummary = useCallback(() => {
    api.usage.summary(usageSummaryQueryForPeriod('7d')).then(setSummary).catch(() => {})
  }, [])

  useEffect(() => {
    api.usage.limits().then(setLimits).catch(() => {})
    // Automatic check — throttled on the desktop side.
    api.usage.refreshLimits(false).then((r) => setLimits(r.limits)).catch(() => {})
    loadSummary()
    const offLimits = onEvent(USAGE_LIMITS_UPDATED_CHANNEL, (payload) => {
      setLimits((current) => upsert(current, payload as ProviderUsageLimits))
    })
    const offRecorded = onEvent(USAGE_RECORDED_CHANNEL, () => loadSummary())
    return () => {
      offLimits()
      offRecorded()
    }
  }, [loadSummary])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const result = await api.usage.refreshLimits(true)
      setLimits(result.limits)
    } catch {
      // Per-provider failures are reported through `unavailable`.
    } finally {
      setRefreshing(false)
    }
  }, [])

  const totals = summary?.totals

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-foreground">Subscription usage</h2>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="text-xs text-primary hover:text-primary/80 disabled:opacity-50"
        >
          {refreshing ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      {limits.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Plan limits appear for Claude Code and Codex agents that sign in with a subscription.
        </p>
      ) : (
        <div className="space-y-2">
          {limits.map((provider) => (
            <div key={provider.provider} className="rounded-lg border border-border/50 bg-card p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{USAGE_PROVIDER_LABELS[provider.provider]}</span>
                {provider.planType && (
                  <span className="text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded capitalize">{provider.planType}</span>
                )}
              </div>
              {provider.limitReached && (
                <p className="text-xs text-destructive">Limit reached — requests are blocked until the window resets.</p>
              )}
              {provider.windows.length === 0 ? (
                <p className="text-xs text-muted-foreground">{provider.unavailable?.message ?? 'No plan limits reported yet.'}</p>
              ) : (
                provider.windows.map((window) => {
                  const used = effectiveUsedPercent(window)
                  const resetIn = formatResetIn(window.resetsAt)
                  return (
                    <div key={window.id} className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span>{window.label}</span>
                        <span className="text-muted-foreground tabular-nums">
                          {Math.round(used)}%{resetIn ? ` · ${resetIn}` : ''}
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden" role="meter" aria-valuenow={Math.round(used)} aria-valuemin={0} aria-valuemax={100} aria-label={`${window.label}: ${Math.round(used)}% used`}>
                        <div className={`h-full rounded-full ${LEVEL_BAR[usageLimitLevel(used)]}`} style={{ width: `${used}%` }} />
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          ))}
        </div>
      )}

      {totals && totals.records > 0 && (
        <div className="mt-3 rounded-lg border border-border/50 bg-card p-3">
          <div className="text-xs text-muted-foreground mb-1">Last 7 days</div>
          <div className="flex items-baseline justify-between">
            <span className="text-base font-semibold tabular-nums">{formatTokenCount(totalTokens(totals))} tokens</span>
            <span className="text-xs text-muted-foreground tabular-nums">est. {formatUsd(totals.costUsd)}</span>
          </div>
          <p className="text-[10px] text-muted-foreground/70 mt-1">
            Cost is an API-equivalent estimate reported by the provider, not your subscription bill.
          </p>
        </div>
      )}
    </div>
  )
}
