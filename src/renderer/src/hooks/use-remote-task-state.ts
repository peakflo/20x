import { createContext, useEffect } from 'react'
import type { RemoteTaskState } from '@shared/enterprise-runners'
import { requestRemoteTaskState, useRemoteTaskStore } from '@/stores/remote-task-store'

/** Provides the open task's remote state to deep transcript components. */
export const RemoteTaskContext = createContext<RemoteTaskState | null>(null)

/**
 * Decision handler for permission cards of remote sessions. Allow and Reject
 * call it with an explicit boolean; composer text never answers a permission.
 */
export type RemoteDecision = (decision: { approved: boolean; requestId?: string; label: string }) => void
export const RemoteDecisionContext = createContext<RemoteDecision | null>(null)

/**
 * Live remote (runner) state of a task, or null when the task does not run on
 * a runner. One shared IPC subscription serves every caller.
 */
export function useRemoteTaskState(taskId: string | undefined, enabled = true): RemoteTaskState | null {
  useEffect(() => {
    if (taskId && enabled) requestRemoteTaskState(taskId)
  }, [taskId, enabled])
  return useRemoteTaskStore((s) => (taskId ? s.states[taskId] ?? null : null))
}
