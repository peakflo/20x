import { create } from 'zustand'
import { api } from '../api/client'
import { onEvent } from '../api/websocket'
import type { RemoteTaskState, RemoteTaskStateEvent } from '@shared/enterprise-runners'

interface RemoteTaskStore {
  /** Remote sync state per task id; absent = a local task. */
  states: Record<string, RemoteTaskState>
  load: (taskId: string) => Promise<void>
  apply: (event: RemoteTaskStateEvent) => void
}

export const useRemoteTaskStore = create<RemoteTaskStore>((set) => {
  // Same WebSocket path as every other mobile event.
  onEvent('enterprise-runners:task-state', (payload) => {
    const event = payload as RemoteTaskStateEvent
    if (event?.taskId && event.state) set((s) => ({ states: { ...s.states, [event.taskId]: event.state } }))
  })

  return {
    states: {},
    load: async (taskId) => {
      try {
        const state = await api.tasks.remoteState(taskId)
        set((s) => {
          const next = { ...s.states }
          if (state) next[taskId] = state
          else delete next[taskId]
          return { states: next }
        })
      } catch {
        // Old desktop without the route: the task is simply treated as local.
      }
    },
    apply: (event) => set((s) => ({ states: { ...s.states, [event.taskId]: event.state } }))
  }
})
