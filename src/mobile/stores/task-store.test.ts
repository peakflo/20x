import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { useTaskStore, type Task } from './task-store'
import { api } from '../api/client'

beforeEach(() => {
  useTaskStore.setState({
    tasks: [],
    isLoading: false
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
      ;(api.tasks.list as unknown as Mock).mockResolvedValue(mockTasks)

      await useTaskStore.getState().fetchTasks()

      expect(useTaskStore.getState().tasks).toEqual(mockTasks)
      expect(useTaskStore.getState().isLoading).toBe(false)
    })

    it('clears loading on failure', async () => {
      ;(api.tasks.list as unknown as Mock).mockRejectedValue(new Error('Network error'))

      await useTaskStore.getState().fetchTasks()

      expect(useTaskStore.getState().isLoading).toBe(false)
    })
  })

  describe('createTask', () => {
    it('creates task and prepends to list', async () => {
      useTaskStore.setState({ tasks: [{ id: 't1', title: 'Existing' }] as unknown as Task[] })
      const newTask = { id: 't2', title: 'New Task', description: '', type: 'general', priority: 'medium' }
      ;(api.tasks.create as unknown as Mock).mockResolvedValue(newTask)

      const result = await useTaskStore.getState().createTask({ title: 'New Task' })

      expect(result).toEqual(newTask)
      const tasks = useTaskStore.getState().tasks
      expect(tasks[0].id).toBe('t2')
      expect(tasks).toHaveLength(2)
    })

    it('deduplicates if task already exists', async () => {
      const existingTask = { id: 't1', title: 'Existing' } as unknown as Task
      useTaskStore.setState({ tasks: [existingTask] })
      ;(api.tasks.create as unknown as Mock).mockResolvedValue({ id: 't1', title: 'Existing' })

      const result = await useTaskStore.getState().createTask({ title: 'Existing' })

      expect(result).toBeDefined()
      expect(useTaskStore.getState().tasks).toHaveLength(1)
    })

    it('returns null on failure', async () => {
      ;(api.tasks.create as unknown as Mock).mockRejectedValue(new Error('Server error'))

      const result = await useTaskStore.getState().createTask({ title: 'Fail' })

      expect(result).toBeNull()
    })
  })

  describe('updateTask', () => {
    it('updates task in-place', async () => {
      useTaskStore.setState({
        tasks: [{ id: 't1', title: 'Old' }] as unknown as Task[]
      })
      const updated = { id: 't1', title: 'Updated' }
      ;(api.tasks.update as unknown as Mock).mockResolvedValue(updated)

      const result = await useTaskStore.getState().updateTask('t1', { title: 'Updated' })

      expect(result).toBe(true)
      expect(useTaskStore.getState().tasks[0].title).toBe('Updated')
    })

    it('returns false on failure', async () => {
      useTaskStore.setState({
        tasks: [{ id: 't1', title: 'Old' }] as unknown as Task[]
      })
      ;(api.tasks.update as unknown as Mock).mockRejectedValue(new Error('fail'))

      const result = await useTaskStore.getState().updateTask('t1', { title: 'X' })

      expect(result).toBe(false)
      // Original task unchanged
      expect(useTaskStore.getState().tasks[0].title).toBe('Old')
    })
  })
})
