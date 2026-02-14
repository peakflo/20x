import { create } from 'zustand'
import type { WorkfloTask, CreateTaskDTO, UpdateTaskDTO } from '@/types'
import { taskApi, taskSourceApi, onTaskUpdated } from '@/lib/ipc-client'

interface TaskState {
  tasks: WorkfloTask[]
  selectedTaskId: string | null
  isLoading: boolean
  error: string | null

  fetchTasks: () => Promise<void>
  createTask: (data: CreateTaskDTO) => Promise<WorkfloTask | null>
  updateTask: (id: string, data: UpdateTaskDTO) => Promise<WorkfloTask | null>
  deleteTask: (id: string) => Promise<boolean>
  selectTask: (id: string | null) => void
}

export const useTaskStore = create<TaskState>((set) => ({
  tasks: [],
  selectedTaskId: null,
  isLoading: false,
  error: null,

  fetchTasks: async () => {
    set({ isLoading: true, error: null })
    try {
      const tasks = await taskApi.getAll()
      set({ tasks, isLoading: false })
    } catch (err) {
      set({ error: String(err), isLoading: false })
    }
  },

  createTask: async (data) => {
    try {
      const task = await taskApi.create(data)
      set((state) => ({ tasks: [task, ...state.tasks] }))
      return task
    } catch (err) {
      set({ error: String(err) })
      return null
    }
  },

  updateTask: async (id, data) => {
    try {
      const updated = await taskApi.update(id, data)
      if (updated) {
        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === id ? updated : t))
        }))
        // Fire background export if task has a source
        if (updated.source_id && updated.external_id) {
          taskSourceApi.exportUpdate(id, data as Record<string, unknown>).catch(console.error)
        }
      }
      return updated || null
    } catch (err) {
      set({ error: String(err) })
      return null
    }
  },

  deleteTask: async (id) => {
    try {
      const success = await taskApi.delete(id)
      if (success) {
        set((state) => ({
          tasks: state.tasks.filter((t) => t.id !== id),
          selectedTaskId: state.selectedTaskId === id ? null : state.selectedTaskId
        }))
      }
      return success
    } catch (err) {
      set({ error: String(err) })
      return false
    }
  },

  selectTask: (id) => set({ selectedTaskId: id })
}))

// Listen for task updates from the backend (e.g., when agent changes task status)
onTaskUpdated((event) => {
  useTaskStore.setState((state) => ({
    tasks: state.tasks.map((t) =>
      t.id === event.taskId ? { ...t, ...event.updates } : t
    )
  }))
})
