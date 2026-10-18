import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { useTaskStore, type Task } from './task-store'
import { api } from '../api/client'

beforeEach(() => {
  useTaskStore.setState({
    tasks: [],
    isLoading: false,
    completedTotal: 0,
    completedLoaded: 0,
    completedLoading: false
  })
  vi.clearAllMocks()
})

describe('useTaskStore', () => {
  describe('fetchTasks', () => {
    it('loads the open set and count without downloading completed history', async () => {
      const mockTasks = [
        { id: 't1', title: 'Task 1' },
        { id: 't2', title: 'Task 2' }
      ]
      ;(api.tasks.open as unknown as Mock).mockResolvedValue(mockTasks)
      ;(api.tasks.completedPage as unknown as Mock).mockResolvedValue({ tasks: [], total: 125 })

      await useTaskStore.getState().fetchTasks()

      expect(useTaskStore.getState().tasks).toEqual(mockTasks)
      expect(useTaskStore.getState().completedTotal).toBe(125)
      expect(api.tasks.completedPage).toHaveBeenCalledWith({ offset: 0, limit: 0 })
      expect(api.tasks.list).not.toHaveBeenCalled()
      expect(useTaskStore.getState().isLoading).toBe(false)
    })

    it('clears loading on failure', async () => {
      ;(api.tasks.open as unknown as Mock).mockRejectedValue(new Error('Network error'))

      await useTaskStore.getState().fetchTasks()

      expect(useTaskStore.getState().isLoading).toBe(false)
    })
  })

  describe('completed history', () => {
    const task = (id: string, status = 'completed', parent_task_id: string | null = null) =>
      ({ id, title: id, status, parent_task_id }) as Task

    it('loads a page with subtasks, advances by parent count, and keeps history on refresh', async () => {
      const page = api.tasks.completedPage as unknown as Mock
      page.mockResolvedValueOnce({ tasks: [task('c1'), task('child', 'completed', 'c1'), task('c2')], total: 90 })
      await useTaskStore.getState().loadMoreCompleted()
      expect(page).toHaveBeenCalledWith({ offset: 0, limit: 50 })
      expect(useTaskStore.getState().completedLoaded).toBe(2)

      ;(api.tasks.open as unknown as Mock).mockResolvedValueOnce([task('o1', 'not_started')])
      page.mockResolvedValueOnce({ tasks: [], total: 90 })
      await useTaskStore.getState().fetchTasks()
      expect(useTaskStore.getState().tasks.map((t) => t.id)).toEqual(['o1', 'c1', 'child', 'c2'])

      page.mockResolvedValueOnce({ tasks: [task('c2'), task('c3')], total: 90 })
      await useTaskStore.getState().loadMoreCompleted()
      expect(page).toHaveBeenLastCalledWith({ offset: 2, limit: 50 })
      expect(useTaskStore.getState().tasks.filter((t) => t.id === 'c2')).toHaveLength(1)
    })

    it('loads a closed task by id for a direct link', async () => {
      ;(api.tasks.get as unknown as Mock).mockResolvedValueOnce(task('old'))
      expect((await useTaskStore.getState().ensureTask('old'))?.id).toBe('old')
      expect(useTaskStore.getState().tasks.map((t) => t.id)).toEqual(['old'])
      await useTaskStore.getState().ensureTask('old')
      expect(api.tasks.get).toHaveBeenCalledTimes(1)
    })

    it('moves a completed task to the closed group from the server response', async () => {
      useTaskStore.setState({ tasks: [task('active', 'ready_for_review')] })
      ;(api.tasks.complete as unknown as Mock).mockResolvedValueOnce({
        completed: true, status: 'completed', task: task('active')
      })
      await useTaskStore.getState().completeTask('active', false)
      expect(api.tasks.complete).toHaveBeenCalledWith('active', false)
      expect(useTaskStore.getState().tasks[0].status).toBe('completed')
    })

    it('does not change the task when the source has not confirmed completion', async () => {
      useTaskStore.setState({ tasks: [task('active', 'ready_for_review')] })
      ;(api.tasks.complete as unknown as Mock).mockResolvedValueOnce({
        completed: false, status: 'ready_for_review', task: task('active', 'ready_for_review')
      })
      await expect(useTaskStore.getState().completeTask('active', true)).rejects.toThrow('not confirmed')
      expect(useTaskStore.getState().tasks[0].status).toBe('ready_for_review')
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
