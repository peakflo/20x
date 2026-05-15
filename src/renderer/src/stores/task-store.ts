import { create } from 'zustand'
import type { WorkfloTask, CreateTaskDTO, UpdateTaskDTO, OutputField, OutputFieldType } from '@/types'
import { taskApi, taskSourceApi, onTaskUpdated, onTaskCreated, onTasksRefresh } from '@/lib/ipc-client'

const VALID_OUTPUT_FIELD_TYPES = new Set<OutputFieldType>([
  'text',
  'number',
  'email',
  'textarea',
  'list',
  'date',
  'file',
  'boolean',
  'country',
  'currency',
  'url'
])

function normalizeOutputField(field: unknown, index: number): OutputField | null {
  if (!field || typeof field !== 'object') return null

  const raw = field as Partial<OutputField>
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id : `output_field_${index + 1}`
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : id.replace(/_/g, ' ')
  const rawType = typeof raw.type === 'string' ? raw.type : ''
  const type = VALID_OUTPUT_FIELD_TYPES.has(rawType as OutputFieldType) ? (rawType as OutputFieldType) : 'text'

  return {
    ...raw,
    id,
    name,
    type,
    options: Array.isArray(raw.options) ? raw.options.filter((option): option is string => typeof option === 'string') : undefined
  }
}

/** Ensure array fields on a task are always proper arrays (guards against undefined/null from external sources) */
function normalizeTask(task: WorkfloTask): WorkfloTask {
  return {
    ...task,
    labels: Array.isArray(task.labels) ? task.labels : [],
    repos: Array.isArray(task.repos) ? task.repos : [],
    attachments: Array.isArray(task.attachments) ? task.attachments : [],
    output_fields: Array.isArray(task.output_fields)
      ? task.output_fields
          .map((field, index) => normalizeOutputField(field, index))
          .filter((field): field is OutputField => field !== null)
      : [],
    skill_ids: task.skill_ids == null ? null : Array.isArray(task.skill_ids) ? task.skill_ids : []
  }
}

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
      const tasks = (await taskApi.getAll()).map(normalizeTask)
      set({ tasks, isLoading: false })
    } catch (err) {
      set({ error: String(err), isLoading: false })
    }
  },

  createTask: async (data) => {
    try {
      const task = normalizeTask(await taskApi.create(data))
      set((state) => ({ tasks: [task, ...state.tasks], error: null }))
      return task
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ error: message })
      throw err
    }
  },

  updateTask: async (id, data) => {
    try {
      const raw = await taskApi.update(id, data)
      const updated = raw ? normalizeTask(raw) : null
      if (updated) {
        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === id ? updated : t)),
          error: null
        }))
        // Fire background export if task has a source
        if (updated.source_id && updated.external_id) {
          taskSourceApi.exportUpdate(id, data as Record<string, unknown>).catch(console.error)
        }
      }
      return updated || null
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ error: message })
      throw err
    }
  },

  deleteTask: async (id) => {
    try {
      const success = await taskApi.delete(id)
      if (success) {
        set((state) => ({
          tasks: state.tasks.filter((t) => t.id !== id),
          selectedTaskId: state.selectedTaskId === id ? null : state.selectedTaskId,
          error: null
        }))
      }
      return success
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ error: message })
      throw err
    }
  },

  selectTask: (id) => set({ selectedTaskId: id })
}))

// Listen for task updates from the backend (e.g., when agent changes task status)
onTaskUpdated((event) => {
  useTaskStore.setState((state) => ({
    tasks: state.tasks.map((t) =>
      t.id === event.taskId ? normalizeTask({ ...t, ...event.updates }) : t
    )
  }))
})

// Listen for tasks created externally (e.g., via task-management MCP server)
onTaskCreated((event) => {
  useTaskStore.setState((state) => {
    // Avoid duplicates
    if (state.tasks.some((t) => t.id === event.task.id)) return state
    return { tasks: [normalizeTask(event.task), ...state.tasks] }
  })
})

// Listen for tasks:refresh from main process (recurrence scheduler, heartbeat, etc.)
onTasksRefresh(() => {
  useTaskStore.getState().fetchTasks()
})
