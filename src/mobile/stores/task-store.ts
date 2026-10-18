import { create } from 'zustand'
import { api } from '../api/client'
import { onEvent } from '../api/websocket'
import { TaskStatus } from '@shared/constants'
import { isReviewUnseen } from '@shared/review-seen'
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
  complete_at_source: boolean | null
  review_entered_at?: string | null
  review_seen_at?: string | null
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
  /** Review seen state (see @shared/review-seen). Optimistic; desktop main is the source of truth. */
  markReviewSeen: (id: string) => Promise<void>
  markReviewUnseen: (id: string) => Promise<void>
  markAllReviewSeen: () => Promise<void>
}

type ReviewSeenPatch = Partial<Pick<Task, 'review_entered_at' | 'review_seen_at'>>

function reviewSeenPatchFrom(task: unknown): ReviewSeenPatch | null {
  if (!task || typeof task !== 'object') return null
  const t = task as Task
  return { review_entered_at: t.review_entered_at ?? null, review_seen_at: t.review_seen_at ?? null }
}

export const useTaskStore = create<TaskState>((set, get) => {
  const patchTasks = (patches: Map<string, ReviewSeenPatch>) => {
    if (patches.size === 0) return
    set((state) => ({
      tasks: state.tasks.map((t) => {
        const patch = patches.get(t.id)
        return patch ? { ...t, ...patch } : t
      })
    }))
  }

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
    },

    markReviewSeen: async (id) => {
      const previous = get().tasks.find((t) => t.id === id)
      if (!previous || !isReviewUnseen(previous)) return
      patchTasks(new Map([[id, { review_seen_at: new Date().toISOString() }]]))
      try {
        const patch = reviewSeenPatchFrom(await api.tasks.markReviewSeen(id))
        if (patch) patchTasks(new Map([[id, patch]]))
      } catch (e) {
        console.error('Failed to mark task seen:', e)
        patchTasks(new Map([[id, reviewSeenPatchFrom(previous)!]]))
      }
    },

    markReviewUnseen: async (id) => {
      const previous = get().tasks.find((t) => t.id === id)
      if (!previous || previous.status !== TaskStatus.ReadyForReview) return
      patchTasks(new Map([[id, { review_seen_at: null }]]))
      try {
        const patch = reviewSeenPatchFrom(await api.tasks.markReviewUnseen(id))
        if (patch) patchTasks(new Map([[id, patch]]))
      } catch (e) {
        console.error('Failed to mark task unseen:', e)
        patchTasks(new Map([[id, reviewSeenPatchFrom(previous)!]]))
      }
    },

    markAllReviewSeen: async () => {
      const previous = new Map<string, ReviewSeenPatch>()
      for (const t of get().tasks) if (isReviewUnseen(t)) previous.set(t.id, reviewSeenPatchFrom(t)!)
      if (previous.size === 0) return
      const now = new Date().toISOString()
      patchTasks(new Map([...previous.keys()].map((id) => [id, { review_seen_at: now }])))
      try {
        const changed = await api.tasks.markAllReviewSeen()
        const patches = new Map<string, ReviewSeenPatch>()
        for (const t of changed ?? []) {
          const patch = reviewSeenPatchFrom(t)
          if (patch) patches.set((t as Task).id, patch)
        }
        patchTasks(patches)
      } catch (e) {
        console.error('Failed to mark all review tasks seen:', e)
        patchTasks(previous)
      }
    }
  }
})
