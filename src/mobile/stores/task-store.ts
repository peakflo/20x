import { create } from 'zustand'
import { api } from '../api/client'
import { onEvent } from '../api/websocket'
import type { TaskStatus } from '@shared/constants'

// Re-export for convenience
export type { TaskStatus }

export interface Task {
  id: string
  title: string
  description: string
  type: string
  priority: string
  status: string
  assignee: string
  due_date: string | null
  labels: string[]
  attachments: unknown[]
  repos: string[]
  output_fields: unknown[]
  agent_id: string | null
  session_id: string | null
  external_id: string | null
  source_id: string | null
  source: string
  skill_ids: string[] | null
  snoozed_until: string | null
  resolution: string | null
  feedback_rating: number | null
  feedback_comment: string | null
  is_recurring: boolean
  recurrence_pattern: unknown
  recurrence_parent_id: string | null
  last_occurrence_at: string | null
  next_occurrence_at: string | null
  heartbeat_enabled?: boolean
  heartbeat_interval_minutes?: number | null
  heartbeat_last_check_at?: string | null
  heartbeat_next_check_at?: string | null
  parent_task_id: string | null
  created_at: string
  updated_at: string
}

interface TaskState {
  tasks: Task[]
  isLoading: boolean
  isSyncing: boolean
  fetchTasks: () => Promise<void>
  syncAndFetch: () => Promise<void>
  createTask: (data: Record<string, unknown>) => Promise<Task | null>
  updateTask: (id: string, data: Record<string, unknown>) => Promise<boolean>
}

export const useTaskStore = create<TaskState>((set, get) => {
  // Listen to WebSocket events
  onEvent('task:updated', (payload) => {
    const { taskId, updates } = payload as { taskId: string; updates: Partial<Task> }
    const found = get().tasks.some((t) => t.id === taskId)
    if (found) {
      set((state) => ({
        tasks: state.tasks.map((t) =>
          t.id === taskId ? { ...t, ...updates } : t
        )
      }))
    } else {
      // Task not yet in the list (created on desktop) — fetch to pick it up
      get().fetchTasks()
    }
  })

  onEvent('task:created', (payload) => {
    const { task } = payload as { task: Task }
    set((state) => {
      // Deduplicate — task may already exist from a concurrent fetchTasks()
      if (state.tasks.some((t) => t.id === task.id)) return state
      return { tasks: [task, ...state.tasks] }
    })
  })

  return {
    tasks: [],
    isLoading: false,
    isSyncing: false,

    fetchTasks: async () => {
      set({ isLoading: true })
      try {
        const tasks = (await api.tasks.list()) as Task[]
        set({ tasks, isLoading: false })
      } catch {
        set({ isLoading: false })
      }
    },

    syncAndFetch: async () => {
      set({ isSyncing: true })
      try {
        await api.taskSources.syncAll()
      } catch (e) {
        console.error('Failed to sync task sources:', e)
      }
      // Always re-fetch tasks after sync (even if sync failed, tasks may have changed)
      try {
        const tasks = (await api.tasks.list()) as Task[]
        set({ tasks, isSyncing: false })
      } catch {
        set({ isSyncing: false })
      }
    },

    createTask: async (data) => {
      try {
        const task = (await api.tasks.create(data)) as Task
        set((state) => {
          if (state.tasks.some((t) => t.id === task.id)) return state
          return { tasks: [task, ...state.tasks] }
        })
        return task
      } catch (e) {
        console.error('Failed to create task:', e)
        return null
      }
    },

    updateTask: async (id, data) => {
      try {
        const updated = (await api.tasks.update(id, data)) as Task
        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === id ? updated : t))
        }))
        return true
      } catch (e) {
        console.error('Failed to update task:', e)
        return false
      }
    }
  }
})
