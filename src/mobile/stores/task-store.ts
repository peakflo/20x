import { create } from 'zustand'
import { api } from '../api/client'
import { onEvent } from '../api/websocket'
import type { TaskStatus } from '@shared/constants'
import { captureAnalyticsEvent, getTaskAnalyticsProperties, getTaskMutationProperties } from '@/lib/analytics'

// Re-export for convenience
export type { TaskStatus }

export interface TaskAttachment {
  id: string
  filename: string
  size: number
  mime_type: string
  added_at: string
}

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
  attachments: TaskAttachment[]
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
  auto_start_agent: boolean
  auto_complete_without_review: boolean
  parent_task_id: string | null
  sort_order: number
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
    const previousTask = get().tasks.find((t) => t.id === taskId)
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
    if (updates.status && previousTask?.status !== updates.status) {
      captureAnalyticsEvent('task_status_changed', {
        task_id: taskId,
        previous_status: previousTask?.status,
        next_status: updates.status,
        source: 'backend'
      })
    }
  })

  onEvent('task:created', (payload) => {
    const { task } = payload as { task: Task }
    set((state) => {
      // Deduplicate — task may already exist from a concurrent fetchTasks()
      if (state.tasks.some((t) => t.id === task.id)) return state
      captureAnalyticsEvent('task_created', {
        ...getTaskAnalyticsProperties(task),
        source: 'backend'
      })
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
        captureAnalyticsEvent('task_created', {
          ...getTaskAnalyticsProperties(task),
          ...getTaskMutationProperties(data)
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
        captureAnalyticsEvent('task_updated', {
          ...getTaskAnalyticsProperties(updated),
          ...getTaskMutationProperties(data)
        })
        return true
      } catch (e) {
        console.error('Failed to update task:', e)
        return false
      }
    }
  }
})
