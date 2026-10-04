import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProviderUsageLimits, UsagePeriod, UsageSummary } from '@shared/usage'
import { usageSummaryQueryForPeriod } from '@shared/usage'
import { onUsageLimitsUpdated, onUsageRecorded, usageApi } from '@/lib/ipc-client'

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
}

/**
 * Plan limits + token usage summary for the selected period. Opening the view
 * triggers an automatic (throttled) plan-limit check; live updates arrive over
 * IPC as agents run.
 */
export function useSubscriptionUsage(period: UsagePeriod): SubscriptionUsageState {
  const [limits, setLimits] = useState<ProviderUsageLimits[]>([])
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const periodRef = useRef(period)
  periodRef.current = period

  const loadSummary = useCallback(async () => {
    try {
      const next = await usageApi.getSummary(usageSummaryQueryForPeriod(periodRef.current))
      setSummary(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const upsertLimits = useCallback((next: ProviderUsageLimits) => {
    setLimits((current) => {
      const others = current.filter((l) => l.provider !== next.provider)
      return [...others, next].sort((a, b) => a.provider.localeCompare(b.provider))
    })
  }, [])

  // Initial load + automatic plan-limit check (throttled in the main process).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const current = await usageApi.getLimits()
        if (!cancelled) setLimits(current)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
      try {
        const result = await usageApi.refreshLimits()
        if (!cancelled) setLimits(result.limits)
      } catch {
        // Probe failures surface per provider through `unavailable`.
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    void loadSummary()
  }, [period, loadSummary])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const offLimits = onUsageLimitsUpdated(upsertLimits)
    const offRecorded = onUsageRecorded(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { void loadSummary() }, SUMMARY_RELOAD_DEBOUNCE_MS)
    })
    return () => {
      if (timer) clearTimeout(timer)
      offLimits()
      offRecorded()
    }
  }, [loadSummary, upsertLimits])

  const refreshLimits = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      const result = await usageApi.refreshLimits({ force: true })
      setLimits(result.limits)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshing(false)
    }
  }, [])

  return { limits, summary, loading, refreshing, error, refreshLimits }
}
