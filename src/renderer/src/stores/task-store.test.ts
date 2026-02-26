import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useTaskStore } from './task-store'

const mockElectronAPI = window.electronAPI

beforeEach(() => {
  useTaskStore.setState({
    tasks: [],
    selectedTaskId: null,
    isLoading: false,
    error: null
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

    it('throws and sets error on failure', async () => {
      ;(mockElectronAPI.db.createTask as any).mockRejectedValue(new Error('fail'))
      await expect(useTaskStore.getState().createTask({ title: 'X' } as any)).rejects.toThrow('fail')
      expect(useTaskStore.getState().error).toBe('fail')
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
  })
})
