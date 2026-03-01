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
  created_at: string
  updated_at: string
}

interface TaskState {
  tasks: Task[]
  isLoading: boolean
  fetchTasks: () => Promise<void>
  updateTask: (id: string, data: Record<string, unknown>) => Promise<void>
}

export const useTaskStore = create<TaskState>((set, get) => {
  // Listen to WebSocket events
  onEvent('task:updated', (payload) => {
    const { taskId, updates } = payload as { taskId: string; updates: Partial<Task> }
    set({
      tasks: get().tasks.map((t) =>
        t.id === taskId ? { ...t, ...updates } : t
      )
    })
  })

  onEvent('task:created', (payload) => {
    const { task } = payload as { task: Task }
    set({ tasks: [task, ...get().tasks] })
  })

  return {
    tasks: [],
    isLoading: false,

    fetchTasks: async () => {
      set({ isLoading: true })
      try {
        const tasks = (await api.tasks.list()) as Task[]
        set({ tasks, isLoading: false })
      } catch {
        set({ isLoading: false })
      }
    },

    updateTask: async (id, data) => {
      try {
        const updated = (await api.tasks.update(id, data)) as Task
        set({
          tasks: get().tasks.map((t) => (t.id === id ? updated : t))
        })
      } catch (e) {
        console.error('Failed to update task:', e)
      }
    }
  }
})
