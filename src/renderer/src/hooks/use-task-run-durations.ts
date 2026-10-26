import { useEffect, useState } from 'react'
import type { TaskRunDuration } from '@shared/task-run-duration'

/** Refresh open intervals while the list or task view is visible. */
export function useTaskRunDurations(taskIds: string[]): Record<string, TaskRunDuration> {
  const idsKey = taskIds.join('\0')
  const [durations, setDurations] = useState<Record<string, TaskRunDuration>>({})

  useEffect(() => {
    const ids = idsKey ? idsKey.split('\0') : []
    let active = true
    if (ids.length === 0 || !window.electronAPI.tasks?.getRunDurations) {
      setDurations({})
      return
    }

    const refresh = () => {
      void window.electronAPI.tasks.getRunDurations(ids)
        .then((result) => { if (active) setDurations((prev) => reuseUnchangedDurations(prev, result)) })
        .catch((error) => console.error('Could not load agent run time:', error))
    }
    refresh()
    const timer = window.setInterval(refresh, 5000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [idsKey])

  return durations
}

/**
 * Each poll returns fresh objects for every task. Keep the previous object for
 * entries whose values did not change (and the previous map when nothing
 * changed), so memoized task rows only re-render when their own duration does.
 */
export function reuseUnchangedDurations(
  prev: Record<string, TaskRunDuration>,
  next: Record<string, TaskRunDuration>
): Record<string, TaskRunDuration> {
  let changed = Object.keys(prev).length !== Object.keys(next).length
  const merged: Record<string, TaskRunDuration> = {}
  for (const [id, value] of Object.entries(next)) {
    const old = prev[id]
    if (old && old.durationMs === value.durationMs && old.isRunning === value.isRunning) {
      merged[id] = old
    } else {
      merged[id] = value
      changed = true
    }
  }
  return changed ? merged : prev
}

export function formatTaskRunDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}
