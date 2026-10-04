import { useEffect, useState } from 'react'
import type { ContextUsageSnapshot } from '@shared/context-usage'
import { agentSessionApi } from '@/lib/ipc-client'

interface KeyedSnapshot {
  taskId: string
  usage: ContextUsageSnapshot | null
}

/**
 * Latest context-window snapshot for one task. Hydrates from the main process
 * on mount and then follows the live `agent:context-usage` pushes for that task.
 */
export function useContextUsage(taskId: string | null | undefined): ContextUsageSnapshot | null {
  const [keyed, setKeyed] = useState<KeyedSnapshot | null>(null)

  useEffect(() => {
    if (!taskId) return
    const api = window.electronAPI?.agentSession
    if (typeof api?.getContextUsage !== 'function' || typeof api?.onContextUsage !== 'function') return

    let active = true
    // A live push that arrives before the initial read is newer than the read result.
    let receivedLive = false

    const unsubscribe = agentSessionApi.onContextUsage((snapshot) => {
      if (!active || snapshot.taskId !== taskId) return
      receivedLive = true
      setKeyed({ taskId, usage: snapshot })
    })

    void agentSessionApi.getContextUsage(taskId).then(
      (snapshot) => {
        if (!active || receivedLive || !snapshot) return
        setKeyed({ taskId, usage: snapshot })
      },
      (error: unknown) => {
        console.warn('[use-context-usage] getContextUsage failed:', error)
      }
    )

    return () => {
      active = false
      unsubscribe()
    }
  }, [taskId])

  // The state is keyed by task, so a previous task's snapshot never leaks across a taskId change.
  return taskId && keyed?.taskId === taskId ? keyed.usage : null
}
