import { create } from 'zustand'
import type { RemoteTaskState } from '@shared/enterprise-runners'

interface RemoteTaskStoreState {
  states: Record<string, RemoteTaskState | null>
  set: (taskId: string, state: RemoteTaskState | null) => void
}

export const useRemoteTaskStore = create<RemoteTaskStoreState>((set) => ({
  states: {},
  set: (taskId, state) => set((s) => ({ states: { ...s.states, [taskId]: state } }))
}))

const requested = new Set<string>()
let unsubscribe: (() => void) | null = null

function api() {
  return typeof window === 'undefined' ? undefined : window.electronAPI?.enterpriseRunners
}

function ensureSubscribed(): void {
  if (unsubscribe) return
  const runners = api()
  if (!runners?.onTaskState) return
  unsubscribe = runners.onTaskState((event) => {
    useRemoteTaskStore.getState().set(event.taskId, event.state)
  })
}

/** Test helper: forget cached requests and the shared subscription. */
export function resetRemoteTaskStore(): void {
  requested.clear()
  unsubscribe?.()
  unsubscribe = null
  useRemoteTaskStore.setState({ states: {} })
}

export function requestRemoteTaskState(taskId: string): void {
  ensureSubscribed()
  if (requested.has(taskId)) return
  const runners = api()
  if (!runners?.getTaskState) return
  requested.add(taskId)
  runners.getTaskState(taskId)
    .then((state) => {
      // A pushed event may have landed first; never overwrite it with a stale read.
      if (useRemoteTaskStore.getState().states[taskId] === undefined) useRemoteTaskStore.getState().set(taskId, state)
    })
    .catch(() => {
      requested.delete(taskId)
    })
}
