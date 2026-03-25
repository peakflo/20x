import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { useTaskStore } from './task-store'
import type { WorkfloTask, CreateTaskDTO, UpdateTaskDTO } from '@/types'

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
      ;(mockElectronAPI.db.getTasks as unknown as Mock).mockResolvedValue(mockTasks)

      await useTaskStore.getState().fetchTasks()

      expect(useTaskStore.getState().tasks).toMatchObject(mockTasks)
      expect(useTaskStore.getState().isLoading).toBe(false)
    })

    it('sets error on failure', async () => {
      ;(mockElectronAPI.db.getTasks as unknown as Mock).mockRejectedValue(new Error('DB error'))

      await useTaskStore.getState().fetchTasks()

      expect(useTaskStore.getState().error).toBeTruthy()
      expect(useTaskStore.getState().isLoading).toBe(false)
    })
  })

  describe('createTask', () => {
    it('prepends new task to list', async () => {
      useTaskStore.setState({ tasks: [{ id: 't1', title: 'Existing' }] as unknown as WorkfloTask[] })
      const newTask = { id: 't2', title: 'New Task' }
      ;(mockElectronAPI.db.createTask as unknown as Mock).mockResolvedValue(newTask)

      const result = await useTaskStore.getState().createTask({ title: 'New Task' } as unknown as CreateTaskDTO)

      expect(result).toMatchObject(newTask)
      const tasks = useTaskStore.getState().tasks
      expect(tasks[0].id).toBe('t2')
      expect(tasks).toHaveLength(2)
    })

    it('throws and sets error on failure', async () => {
      ;(mockElectronAPI.db.createTask as unknown as Mock).mockRejectedValue(new Error('fail'))
      await expect(useTaskStore.getState().createTask({ title: 'X' } as unknown as CreateTaskDTO)).rejects.toThrow('fail')
      expect(useTaskStore.getState().error).toBe('fail')
    })
  })

  describe('updateTask', () => {
    it('updates task in-place', async () => {
      useTaskStore.setState({
        tasks: [
          { id: 't1', title: 'Old', source_id: null, external_id: null }
        ] as unknown as WorkfloTask[]
      })
      const updated = { id: 't1', title: 'Updated', source_id: null, external_id: null }
      ;(mockElectronAPI.db.updateTask as unknown as Mock).mockResolvedValue(updated)

      const result = await useTaskStore.getState().updateTask('t1', { title: 'Updated' } as unknown as UpdateTaskDTO)

      expect(result!.title).toBe('Updated')
      expect(useTaskStore.getState().tasks[0].title).toBe('Updated')
    })

    it('fires background export for sourced tasks', async () => {
      useTaskStore.setState({
        tasks: [{ id: 't1', source_id: 'src-1', external_id: 'ext-1' }] as unknown as WorkfloTask[]
      })
      const updated = { id: 't1', title: 'X', source_id: 'src-1', external_id: 'ext-1' }
      ;(mockElectronAPI.db.updateTask as unknown as Mock).mockResolvedValue(updated)

      await useTaskStore.getState().updateTask('t1', { title: 'X' } as unknown as UpdateTaskDTO)

      expect(mockElectronAPI.taskSources.exportUpdate).toHaveBeenCalledWith('t1', { title: 'X' })
    })
  })

  describe('deleteTask', () => {
    it('removes task from list', async () => {
      useTaskStore.setState({
        tasks: [{ id: 't1' }, { id: 't2' }] as unknown as WorkfloTask[],
        selectedTaskId: null
      })
      ;(mockElectronAPI.db.deleteTask as unknown as Mock).mockResolvedValue(true)

      const result = await useTaskStore.getState().deleteTask('t1')

      expect(result).toBe(true)
      expect(useTaskStore.getState().tasks).toHaveLength(1)
      expect(useTaskStore.getState().tasks[0].id).toBe('t2')
    })

    it('clears selection if deleted task was selected', async () => {
      useTaskStore.setState({
        tasks: [{ id: 't1' }] as unknown as WorkfloTask[],
        selectedTaskId: 't1'
      })
      ;(mockElectronAPI.db.deleteTask as unknown as Mock).mockResolvedValue(true)

      await useTaskStore.getState().deleteTask('t1')

      expect(useTaskStore.getState().selectedTaskId).toBeNull()
    })

    it('preserves selection if different task deleted', async () => {
      useTaskStore.setState({
        tasks: [{ id: 't1' }, { id: 't2' }] as unknown as WorkfloTask[],
        selectedTaskId: 't2'
      })
      ;(mockElectronAPI.db.deleteTask as unknown as Mock).mockResolvedValue(true)

      await useTaskStore.getState().deleteTask('t1')

      expect(useTaskStore.getState().selectedTaskId).toBe('t2')
    })
  })

  describe('normalizeTask (via fetchTasks)', () => {
    it('normalizes missing array fields to empty arrays', async () => {
      const taskWithMissingFields = {
        id: 't1',
        title: 'Broken task',
        // labels, repos, attachments, output_fields are missing (undefined)
        // skill_ids is missing (undefined)
      }
      ;(mockElectronAPI.db.getTasks as unknown as Mock).mockResolvedValue([taskWithMissingFields])

      await useTaskStore.getState().fetchTasks()

      const task = useTaskStore.getState().tasks[0]
      expect(Array.isArray(task.labels)).toBe(true)
      expect(task.labels).toEqual([])
      expect(Array.isArray(task.repos)).toBe(true)
      expect(task.repos).toEqual([])
      expect(Array.isArray(task.attachments)).toBe(true)
      expect(task.attachments).toEqual([])
      expect(Array.isArray(task.output_fields)).toBe(true)
      expect(task.output_fields).toEqual([])
      // skill_ids: undefined → null (intentional null semantics for "use agent defaults")
      expect(task.skill_ids).toBeNull()
    })

    it('preserves valid array fields as-is', async () => {
      const taskWithArrays = {
        id: 't2',
        title: 'Good task',
        labels: ['bug', 'urgent'],
        repos: ['org/repo'],
        attachments: [{ id: 'a1', filename: 'f.txt' }],
        output_fields: [{ id: 'o1', label: 'Action' }],
        skill_ids: ['s1', 's2']
      }
      ;(mockElectronAPI.db.getTasks as unknown as Mock).mockResolvedValue([taskWithArrays])

      await useTaskStore.getState().fetchTasks()

      const task = useTaskStore.getState().tasks[0]
      expect(task.labels).toEqual(['bug', 'urgent'])
      expect(task.repos).toEqual(['org/repo'])
      expect(task.skill_ids).toEqual(['s1', 's2'])
    })

    it('preserves skill_ids null (agent defaults)', async () => {
      const taskWithNullSkills = { id: 't3', title: 'Task', skill_ids: null }
      ;(mockElectronAPI.db.getTasks as unknown as Mock).mockResolvedValue([taskWithNullSkills])

      await useTaskStore.getState().fetchTasks()

      expect(useTaskStore.getState().tasks[0].skill_ids).toBeNull()
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
