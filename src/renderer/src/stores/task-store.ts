import { create } from 'zustand'
import type { WorkfloTask, CreateTaskDTO, UpdateTaskDTO, OutputField, OutputFieldType } from '@/types'
import { taskApi, taskSourceApi, onTaskUpdated, onTaskCreated, onTaskDeleted, onTasksRefresh } from '@/lib/ipc-client'
import { captureAnalyticsEvent, getTaskAnalyticsProperties, getTaskMutationProperties } from '@/lib/analytics'
import { TaskStatus } from '@/types'
import { isTaskClosed } from '@shared/constants'

/** Completed top-level tasks fetched per "Show more" page. */
export const COMPLETED_PAGE_SIZE = 50

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

/**
 * Merge fetched tasks into the current list: fetched records replace stale
 * ones by id (keeping list position), new ones are appended.
 */
function mergeTasks(current: WorkfloTask[], incoming: WorkfloTask[]): WorkfloTask[] {
  if (incoming.length === 0) return current
  const byId = new Map(incoming.map((task) => [task.id, task]))
  const merged = current.map((task) => {
    const next = byId.get(task.id)
    if (!next) return task
    byId.delete(task.id)
    return next
  })
  return byId.size > 0 ? [...merged, ...byId.values()] : merged
}

const pendingTaskLoads = new Map<string, Promise<WorkfloTask | null>>()

interface TaskState {
  /**
   * Working set: all open tasks (see Database.getOpenTasks) plus the completed
   * tasks loaded so far. Completed history is NOT loaded up front — it is
   * paged in by loadMoreCompleted(), found by searchCompleted(), or fetched
   * individually by ensureTask().
   */
  tasks: WorkfloTask[]
  selectedTaskId: string | null
  isLoading: boolean
  error: string | null
  /** Number of completed top-level tasks in the database. */
  completedTotal: number
  /** Completed top-level tasks fetched through paging (the next page offset). */
  completedLoaded: number
  completedLoading: boolean

  fetchTasks: () => Promise<void>
  loadMoreCompleted: () => Promise<void>
  searchCompleted: (query: string) => Promise<void>
  refreshCompletedTotal: () => Promise<void>
  /** Load a task (e.g. a completed one referenced by a canvas panel) if it is not in the working set. */
  ensureTask: (id: string) => Promise<WorkfloTask | null>
  createTask: (data: CreateTaskDTO) => Promise<WorkfloTask | null>
  updateTask: (id: string, data: UpdateTaskDTO) => Promise<WorkfloTask | null>
  deleteTask: (id: string) => Promise<boolean>
  selectTask: (id: string | null) => void
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  selectedTaskId: null,
  isLoading: false,
  error: null,
  completedTotal: 0,
  completedLoaded: 0,
  completedLoading: false,

  fetchTasks: async () => {
    set({ isLoading: true, error: null })
    void get().refreshCompletedTotal()
    try {
      let openRaw: WorkfloTask[]
      try {
        openRaw = await taskApi.getOpen()
      } catch (err) {
        // A main process older than this renderer (e.g. dev hot-reload of the
        // UI only) has no open-set handler: fall back to loading everything
        // rather than showing an empty list.
        console.warn('[task-store] getOpenTasks unavailable, loading all tasks:', err)
        openRaw = await taskApi.getAll()
      }
      const open = openRaw.map(normalizeTask)
      const openIds = new Set(open.map((task) => task.id))
      set((state) => ({
        // Keep completed tasks the user already paged in (or that completed
        // during this session); everything else comes from the fresh fetch.
        tasks: [
          ...open,
          ...state.tasks.filter((task) => !openIds.has(task.id) && isTaskClosed(task.status))
        ],
        isLoading: false
      }))
    } catch (err) {
      set({ error: String(err), isLoading: false })
    }
  },

  loadMoreCompleted: async () => {
    if (get().completedLoading) return
    set({ completedLoading: true })
    try {
      const { tasks, total } = await taskApi.getCompletedPage({ offset: get().completedLoaded, limit: COMPLETED_PAGE_SIZE })
      const page = tasks.map(normalizeTask)
      const topLevel = page.filter((task) => !task.parent_task_id).length
      set((state) => ({
        tasks: mergeTasks(state.tasks, page),
        completedTotal: total,
        completedLoaded: state.completedLoaded + topLevel,
        completedLoading: false
      }))
    } catch (err) {
      console.error('[task-store] loadMoreCompleted failed:', err)
      set({ completedLoading: false })
    }
  },

  searchCompleted: async (query) => {
    const q = query.trim()
    if (!q) return
    try {
      const { tasks } = await taskApi.getCompletedPage({ offset: 0, limit: COMPLETED_PAGE_SIZE, query: q })
      if (tasks.length > 0) set((state) => ({ tasks: mergeTasks(state.tasks, tasks.map(normalizeTask)) }))
    } catch (err) {
      console.error('[task-store] searchCompleted failed:', err)
    }
  },

  refreshCompletedTotal: async () => {
    try {
      const { total } = await taskApi.getCompletedPage({ offset: 0, limit: 0 })
      if (typeof total === 'number') set({ completedTotal: total })
    } catch {
      // Count is informational; keep the previous value.
    }
  },

  ensureTask: async (id) => {
    if (!id) return null
    const existing = get().tasks.find((task) => task.id === id)
    if (existing) return existing
    let pending = pendingTaskLoads.get(id)
    if (!pending) {
      pending = taskApi.getById(id)
        .then((raw) => {
          if (!raw) return null
          const task = normalizeTask(raw)
          set((state) => ({ tasks: mergeTasks(state.tasks, [task]) }))
          return task
        })
        .catch(() => null)
        .finally(() => { pendingTaskLoads.delete(id) })
      pendingTaskLoads.set(id, pending)
    }
    return pending
  },

  createTask: async (data) => {
    try {
      const task = normalizeTask(await taskApi.create(data))
      captureAnalyticsEvent('task_created', {
        ...getTaskAnalyticsProperties(task),
        ...getTaskMutationProperties(data as unknown as Record<string, unknown>)
      })
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
        if ('status' in (data as Record<string, unknown>)) void get().refreshCompletedTotal()
        captureAnalyticsEvent('task_updated', {
          ...getTaskAnalyticsProperties(updated),
          ...getTaskMutationProperties(data as Record<string, unknown>)
        })
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
        const deletedTask = useTaskStore.getState().tasks.find((t) => t.id === id)
        set((state) => ({
          tasks: state.tasks.filter((t) => t.id !== id),
          selectedTaskId: state.selectedTaskId === id ? null : state.selectedTaskId,
          error: null
        }))
        captureAnalyticsEvent('task_deleted', deletedTask
          ? getTaskAnalyticsProperties(deletedTask)
          : { task_id: id }
        )
      }
      return success
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ error: message })
      throw err
    }
  },

  selectTask: (id) => {
    set({ selectedTaskId: id })
    // Selecting a task that is not in the working set (e.g. a completed task
    // opened from search, a notification or the command palette) loads it.
    if (id && !get().tasks.some((task) => task.id === id)) void get().ensureTask(id)
  }
}))

// Listen for task updates from the backend (e.g., when agent changes task status)
onTaskUpdated((event) => {
  const previousTask = useTaskStore.getState().tasks.find((t) => t.id === event.taskId)
  const nextStatus = (event.updates as { status?: string }).status
  if (!previousTask) {
    // Not in the working set (completed history that was never paged in):
    // load it when it is reopened so it shows up in the open lists.
    if (nextStatus && !isTaskClosed(nextStatus)) {
      void useTaskStore.getState().ensureTask(event.taskId)
      void useTaskStore.getState().refreshCompletedTotal()
    }
    return
  }
  useTaskStore.setState((state) => ({
    tasks: state.tasks.map((t) =>
      t.id === event.taskId ? normalizeTask({ ...t, ...event.updates }) : t
    )
  }))
  if (nextStatus && previousTask.status !== nextStatus
    && (isTaskClosed(nextStatus) || isTaskClosed(previousTask.status))) {
    void useTaskStore.getState().refreshCompletedTotal()
  }
  if (nextStatus && previousTask?.status !== nextStatus) {
    captureAnalyticsEvent('task_status_changed', {
      task_id: event.taskId,
      previous_status: previousTask?.status,
      next_status: nextStatus,
      source: 'backend'
    })
  }
})

// Listen for tasks created externally (e.g., via task-management MCP server)
onTaskCreated((event) => {
  useTaskStore.setState((state) => {
    // Avoid duplicates
    if (state.tasks.some((t) => t.id === event.task.id)) return state
    captureAnalyticsEvent('task_created', {
      ...getTaskAnalyticsProperties(event.task),
      source: 'backend'
    })
    return { tasks: [normalizeTask(event.task), ...state.tasks] }
  })
})

// Listen for task deletions from backend (UI-initiated or external MCP)
onTaskDeleted((event) => {
  const taskId = event.taskId
  const deletedTask = useTaskStore.getState().tasks.find((t) => t.id === taskId)
  const wasCompletedTopLevel = deletedTask?.status === TaskStatus.Completed && !deletedTask.parent_task_id
  useTaskStore.setState((state) => ({
    tasks: state.tasks.filter((t) => t.id !== taskId),
    selectedTaskId: state.selectedTaskId === taskId ? null : state.selectedTaskId,
    // Keep the paging offset aligned with the database after a removal.
    completedLoaded: wasCompletedTopLevel ? Math.max(0, state.completedLoaded - 1) : state.completedLoaded
  }))
  if (wasCompletedTopLevel) void useTaskStore.getState().refreshCompletedTotal()
  captureAnalyticsEvent('task_deleted', deletedTask
    ? { ...getTaskAnalyticsProperties(deletedTask), source: 'backend' }
    : { task_id: taskId, source: 'backend' }
  )

  // Automatically remove from canvas if it was added.
  // Dynamic import avoids circular dependency and ensures canvas store is only loaded if needed.
  import('./canvas-store').then(({ useCanvasStore }) => {
    useCanvasStore.getState().removePanelsByRefId(taskId)
  })
})

// Listen for tasks:refresh from main process (recurrence scheduler, heartbeat, etc.)
onTasksRefresh(() => {
  useTaskStore.getState().fetchTasks()
})
