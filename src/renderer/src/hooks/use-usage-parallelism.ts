import { useCallback, useEffect, useRef, useState } from 'react'
import type { UsageParallelismPeriod, UsageParallelismResponse } from '@shared/usage'
import { onUsageRecorded, usageApi } from '@/lib/ipc-client'

/** Coalesce bursts of `usage:recorded` events (one per model per turn) into one reload — same debounce as useSubscriptionUsage. */
const RELOAD_DEBOUNCE_MS = 1_000

export interface UsageParallelismState {
  data: UsageParallelismResponse | null
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

/**
 * The "my multiplier" card data for one of the four fixed periods. Live:
 * reloads (debounced) on the same `usage:recorded` event the token-usage
 * summary already subscribes to, since agent activity that moves the
 * multiplier also produces usage events.
 */
export function useUsageParallelism(days: UsageParallelismPeriod): UsageParallelismState {
  const [data, setData] = useState<UsageParallelismResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const daysRef = useRef(days)
  daysRef.current = days

  const load = useCallback(async () => {
    try {
      const result = await usageApi.getParallelismSummary({
        days: daysRef.current,
        utcOffsetMinutes: -new Date().getTimezoneOffset()
      })
      setData(result)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [days, load])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const scheduleReload = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { void load() }, RELOAD_DEBOUNCE_MS)
    }
    const off = onUsageRecorded(scheduleReload)
    return () => {
      if (timer) clearTimeout(timer)
      off()
    }
  }, [load])

  return { data, loading, error, reload: load }
}
