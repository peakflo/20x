import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useTaskStore } from './task-store'
import { useUIStore } from './ui-store'

const mockElectronAPI = window.electronAPI

// Capture the onTaskNavigate callback that was registered during store module init
// (must be captured before vi.clearAllMocks() wipes mock call history)
const taskNavigateCallback: ((taskId: string) => void) | null = (() => {
  const calls = (mockElectronAPI.onTaskNavigate as ReturnType<typeof vi.fn>).mock.calls
  return calls.length > 0 ? calls[0][0] : null
})()

beforeEach(() => {
  useTaskStore.setState({
    tasks: [],
    selectedTaskId: null,
    isLoading: false,
    error: null
  })
  useUIStore.setState({
    sidebarView: 'tasks',
    activeModal: null,
    editingTaskId: null,
    deletingTaskId: null
  })
  vi.clearAllMocks()
})

describe('useTaskStore', () => {
  describe('fetchTasks', () => {
    it('fetches and sets tasks', async () => {
      const mockTasks = [
        { id: 't1', title: 'Task 1' },
        { id: 't2', title: 'Task 2' }
      ]
      ;(mockElectronAPI.db.getTasks as any).mockResolvedValue(mockTasks)

      await useTaskStore.getState().fetchTasks()

      expect(useTaskStore.getState().tasks).toEqual(mockTasks)
      expect(useTaskStore.getState().isLoading).toBe(false)
    })

    it('sets error on failure', async () => {
      ;(mockElectronAPI.db.getTasks as any).mockRejectedValue(new Error('DB error'))

      await useTaskStore.getState().fetchTasks()

      expect(useTaskStore.getState().error).toBeTruthy()
      expect(useTaskStore.getState().isLoading).toBe(false)
    })
  })

  describe('createTask', () => {
    it('prepends new task to list', async () => {
      useTaskStore.setState({ tasks: [{ id: 't1', title: 'Existing' }] as any })
      const newTask = { id: 't2', title: 'New Task' }
      ;(mockElectronAPI.db.createTask as any).mockResolvedValue(newTask)

      const result = await useTaskStore.getState().createTask({ title: 'New Task' } as any)

      expect(result).toEqual(newTask)
      const tasks = useTaskStore.getState().tasks
      expect(tasks[0].id).toBe('t2')
      expect(tasks).toHaveLength(2)
    })

    it('returns null on failure', async () => {
      ;(mockElectronAPI.db.createTask as any).mockRejectedValue(new Error('fail'))
      const result = await useTaskStore.getState().createTask({ title: 'X' } as any)
      expect(result).toBeNull()
    })
  })

  describe('updateTask', () => {
    it('updates task in-place', async () => {
      useTaskStore.setState({
        tasks: [
          { id: 't1', title: 'Old', source_id: null, external_id: null }
        ] as any
      })
      const updated = { id: 't1', title: 'Updated', source_id: null, external_id: null }
      ;(mockElectronAPI.db.updateTask as any).mockResolvedValue(updated)

      const result = await useTaskStore.getState().updateTask('t1', { title: 'Updated' } as any)

      expect(result!.title).toBe('Updated')
      expect(useTaskStore.getState().tasks[0].title).toBe('Updated')
    })

    it('fires background export for sourced tasks', async () => {
      useTaskStore.setState({
        tasks: [{ id: 't1', source_id: 'src-1', external_id: 'ext-1' }] as any
      })
      const updated = { id: 't1', title: 'X', source_id: 'src-1', external_id: 'ext-1' }
      ;(mockElectronAPI.db.updateTask as any).mockResolvedValue(updated)

      await useTaskStore.getState().updateTask('t1', { title: 'X' } as any)

      expect(mockElectronAPI.taskSources.exportUpdate).toHaveBeenCalledWith('t1', { title: 'X' })
    })
  })

  describe('deleteTask', () => {
    it('removes task from list', async () => {
      useTaskStore.setState({
        tasks: [{ id: 't1' }, { id: 't2' }] as any,
        selectedTaskId: null
      })
      ;(mockElectronAPI.db.deleteTask as any).mockResolvedValue(true)

      const result = await useTaskStore.getState().deleteTask('t1')

      expect(result).toBe(true)
      expect(useTaskStore.getState().tasks).toHaveLength(1)
      expect(useTaskStore.getState().tasks[0].id).toBe('t2')
    })

    it('clears selection if deleted task was selected', async () => {
      useTaskStore.setState({
        tasks: [{ id: 't1' }] as any,
        selectedTaskId: 't1'
      })
      ;(mockElectronAPI.db.deleteTask as any).mockResolvedValue(true)

      await useTaskStore.getState().deleteTask('t1')

      expect(useTaskStore.getState().selectedTaskId).toBeNull()
    })

    it('preserves selection if different task deleted', async () => {
      useTaskStore.setState({
        tasks: [{ id: 't1' }, { id: 't2' }] as any,
        selectedTaskId: 't2'
      })
      ;(mockElectronAPI.db.deleteTask as any).mockResolvedValue(true)

      await useTaskStore.getState().deleteTask('t1')

      expect(useTaskStore.getState().selectedTaskId).toBe('t2')
    })
  })

  describe('selectTask', () => {
    it('sets selectedTaskId', () => {
      useTaskStore.getState().selectTask('t1')
      expect(useTaskStore.getState().selectedTaskId).toBe('t1')
    })

    it('clears selection with null', () => {
      useTaskStore.getState().selectTask('t1')
      useTaskStore.getState().selectTask(null)
      expect(useTaskStore.getState().selectedTaskId).toBeNull()
    })

    it('reports selected task to main process', () => {
      useTaskStore.getState().selectTask('t1')
      expect(mockElectronAPI.reportSelectedTask).toHaveBeenCalledWith('t1')
    })

    it('reports null when clearing selection', () => {
      useTaskStore.getState().selectTask(null)
      expect(mockElectronAPI.reportSelectedTask).toHaveBeenCalledWith(null)
    })
  })

  describe('onTaskNavigate', () => {
    it('registers a navigation callback', () => {
      expect(taskNavigateCallback).toBeTypeOf('function')
    })

    it('selects the task when navigation event is received', () => {
      taskNavigateCallback!('task-nav-1')

      expect(useTaskStore.getState().selectedTaskId).toBe('task-nav-1')
    })

    it('reports selected task to main process on navigation', () => {
      taskNavigateCallback!('task-nav-2')

      expect(mockElectronAPI.reportSelectedTask).toHaveBeenCalledWith('task-nav-2')
    })

    it('switches to tasks sidebar view if on skills view', () => {
      useUIStore.setState({ sidebarView: 'skills' })

      taskNavigateCallback!('task-nav-3')

      expect(useUIStore.getState().sidebarView).toBe('tasks')
    })

    it('closes active modal on navigation', () => {
      useUIStore.setState({ activeModal: 'settings', editingTaskId: 'some-task', deletingTaskId: 'other' })

      taskNavigateCallback!('task-nav-4')

      expect(useUIStore.getState().activeModal).toBeNull()
      expect(useUIStore.getState().editingTaskId).toBeNull()
      expect(useUIStore.getState().deletingTaskId).toBeNull()
    })

    it('does not change sidebar view if already on tasks', () => {
      useUIStore.setState({ sidebarView: 'tasks' })

      taskNavigateCallback!('task-nav-5')

      expect(useUIStore.getState().sidebarView).toBe('tasks')
    })

    it('does not touch modal state if no modal is open', () => {
      useUIStore.setState({ activeModal: null })

      taskNavigateCallback!('task-nav-6')

      expect(useUIStore.getState().activeModal).toBeNull()
    })
  })
})
