import { useState, useEffect, useRef } from 'react'
import { onOverdueCheck } from '@/lib/ipc-client'
import type { WorkfloTask } from '@/types'

const SNOOZE_SOMEDAY = '9999-12-31T00:00:00.000Z'

/**
 * Returns a "tick" counter that increments whenever a snoozed task's
 * expiry time is reached, or when the overdue:check event fires.
 *
 * Use this as a dependency in useMemo to force snooze re-evaluation
 * without polling — we schedule a single timer for the nearest expiry.
 */
export function useSnoozeTick(tasks: WorkfloTask[]): number {
  const [tick, setTick] = useState(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Schedule a timer for the next snoozed task to wake up
  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    const now = Date.now()
    let nearestExpiry = Infinity

    for (const task of tasks) {
      if (!task.snoozed_until) continue
      if (task.snoozed_until === SNOOZE_SOMEDAY) continue

      const expiryMs = new Date(task.snoozed_until).getTime()
      if (isNaN(expiryMs)) continue

      // Only consider future expiries
      if (expiryMs > now && expiryMs < nearestExpiry) {
        nearestExpiry = expiryMs
      }
    }

    if (nearestExpiry !== Infinity) {
      // Add 1 second buffer to ensure the expiry time has definitively passed
      const delayMs = Math.max(nearestExpiry - now + 1000, 1000)

      // Cap at 1 hour to prevent issues with very long timers
      const cappedDelay = Math.min(delayMs, 60 * 60 * 1000)

      timerRef.current = setTimeout(() => {
        setTick((t) => t + 1)
      }, cappedDelay)
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [tasks, tick])

  // Also bump tick on every overdue:check event (every 60s from main process)
  // This ensures snooze state is re-evaluated even if the timer drifts
  useEffect(() => {
    const cleanup = onOverdueCheck(() => {
      setTick((t) => t + 1)
    })
    return cleanup
  }, [])

  return tick
}
