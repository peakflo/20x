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
        .then((result) => { if (active) setDurations(result) })
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

export function formatTaskRunDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}
