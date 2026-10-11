import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProviderUsageLimits, UsagePeriod, UsageSummary } from '@shared/usage'
import { usageSummaryQueryForPeriod } from '@shared/usage'
import { onUsageModelPricesUpdated, onUsageRecorded, usageApi } from '@/lib/ipc-client'
import { useUsageStore } from '@/stores/usage-store'

/** Coalesce bursts of `usage:recorded` events (one per model per turn) into one reload. */
const SUMMARY_RELOAD_DEBOUNCE_MS = 1_000

export interface SubscriptionUsageState {
  limits: ProviderUsageLimits[]
  summary: UsageSummary | null
  loading: boolean
  refreshing: boolean
  error: string | null
  /** Re-probe plan limits now (manual refresh). */
  refreshLimits: () => Promise<void>
  /** Runs a provider action offered on a limits card. */
  runLimitsAction: (actionId: string) => Promise<void>
  /** Re-fetches the usage summary (e.g. after the rate table or a custom price changed). */
  reloadSummary: () => Promise<void>
}

/**
 * Plan limits (shared store, live) + token usage summary for the selected
 * period. Opening the view triggers an automatic (throttled) plan-limit check.
 */
export function useSubscriptionUsage(period: UsagePeriod): SubscriptionUsageState {
  const limits = useUsageStore((s) => s.limits)
  const loaded = useUsageStore((s) => s.loaded)
  const refreshing = useUsageStore((s) => s.refreshing)
  const limitsError = useUsageStore((s) => s.error)
  const init = useUsageStore((s) => s.init)
  const refresh = useUsageStore((s) => s.refresh)
  const runAction = useUsageStore((s) => s.runAction)

  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const periodRef = useRef(period)
  periodRef.current = period

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await usageApi.getSummary(usageSummaryQueryForPeriod(periodRef.current)))
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    const release = init()
    // Opening the view asks for a (throttled) re-check even if the store was already live.
    if (useUsageStore.getState().loaded) void refresh(false)
    return release
  }, [init, refresh])

  useEffect(() => {
    void loadSummary()
  }, [period, loadSummary])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const scheduleReload = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { void loadSummary() }, SUMMARY_RELOAD_DEBOUNCE_MS)
    }
    const offRecorded = onUsageRecorded(scheduleReload)
    // A custom price changing (anywhere — e.g. the Model prices dialog) re-prices retroactively.
    const offPrices = onUsageModelPricesUpdated(scheduleReload)
    return () => {
      if (timer) clearTimeout(timer)
      offRecorded()
      offPrices()
    }
  }, [loadSummary])

  return {
    limits,
    summary,
    loading: !loaded,
    refreshing,
    error: limitsError ?? summaryError,
    refreshLimits: () => refresh(true),
    runLimitsAction: runAction,
    reloadSummary: loadSummary
  }
}
