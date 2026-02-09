import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useTasks } from './use-tasks'
import { useTaskStore } from '@/stores/task-store'
import { useUIStore } from '@/stores/ui-store'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'

function makeWorkfloTask(overrides: Partial<WorkfloTask> = {}): WorkfloTask {
  return {
    id: 't1',
    title: 'Task',
    description: '',
    type: 'general',
    priority: 'medium',
    status: TaskStatus.NotStarted,
    assignee: '',
    due_date: null,
    labels: [],
    checklist: [],
    attachments: [],
    repos: [],
    output_fields: [],
    agent_id: null,
    external_id: null,
    source_id: null,
    source: 'local',
    skill_ids: null,
    created_at: '2024-06-15T12:00:00Z',
    updated_at: '2024-06-15T12:00:00Z',
    ...overrides
  }
}

const mockElectronAPI = window.electronAPI

beforeEach(() => {
  vi.clearAllMocks()
  ;(mockElectronAPI.db.getTasks as any).mockResolvedValue([])

  useTaskStore.setState({
    tasks: [],
    selectedTaskId: null,
    isLoading: false,
    error: null
  })
  useUIStore.setState({
    sidebarView: 'tasks',
    statusFilter: 'all',
    priorityFilter: 'all',
    sourceFilter: 'all',
    sortField: 'created_at',
    sortDirection: 'desc',
    searchQuery: '',
    activeModal: null,
    editingTaskId: null,
    deletingTaskId: null
  })
})

describe('useTasks', () => {
  it('calls fetchTasks on mount', async () => {
    renderHook(() => useTasks())
    // useEffect fires fetchTasks asynchronously
    await vi.waitFor(() => {
      expect(mockElectronAPI.db.getTasks).toHaveBeenCalled()
    })
  })

  describe('filtering', () => {
    it('filters by status', () => {
      useTaskStore.setState({
        tasks: [
          makeWorkfloTask({ id: 't1', status: TaskStatus.NotStarted }),
          makeWorkfloTask({ id: 't2', status: TaskStatus.Completed })
        ]
      })
      useUIStore.setState({ statusFilter: TaskStatus.Completed })

      const { result } = renderHook(() => useTasks())
      expect(result.current.tasks).toHaveLength(1)
      expect(result.current.tasks[0].id).toBe('t2')
    })

    it('filters by priority', () => {
      useTaskStore.setState({
        tasks: [
          makeWorkfloTask({ id: 't1', priority: 'high' }),
          makeWorkfloTask({ id: 't2', priority: 'low' })
        ]
      })
      useUIStore.setState({ priorityFilter: 'high' })

      const { result } = renderHook(() => useTasks())
      expect(result.current.tasks).toHaveLength(1)
      expect(result.current.tasks[0].id).toBe('t1')
    })

    it('filters local tasks by sourceFilter=local', () => {
      useTaskStore.setState({
        tasks: [
          makeWorkfloTask({ id: 't1', source_id: null }),
          makeWorkfloTask({ id: 't2', source_id: 'src-1' })
        ]
      })
      useUIStore.setState({ sourceFilter: 'local' })

      const { result } = renderHook(() => useTasks())
      expect(result.current.tasks).toHaveLength(1)
      expect(result.current.tasks[0].id).toBe('t1')
    })

    it('filters by specific source_id', () => {
      useTaskStore.setState({
        tasks: [
          makeWorkfloTask({ id: 't1', source_id: 'src-1' }),
          makeWorkfloTask({ id: 't2', source_id: 'src-2' })
        ]
      })
      useUIStore.setState({ sourceFilter: 'src-1' })

      const { result } = renderHook(() => useTasks())
      expect(result.current.tasks).toHaveLength(1)
      expect(result.current.tasks[0].id).toBe('t1')
    })

    it('filters by search query (title)', () => {
      useTaskStore.setState({
        tasks: [
          makeWorkfloTask({ id: 't1', title: 'Fix bug' }),
          makeWorkfloTask({ id: 't2', title: 'Add feature' })
        ]
      })
      useUIStore.setState({ searchQuery: 'bug' })

      const { result } = renderHook(() => useTasks())
      expect(result.current.tasks).toHaveLength(1)
      expect(result.current.tasks[0].id).toBe('t1')
    })

    it('filters by search query (labels)', () => {
      useTaskStore.setState({
        tasks: [
          makeWorkfloTask({ id: 't1', title: 'Task', labels: ['frontend'] }),
          makeWorkfloTask({ id: 't2', title: 'Task', labels: ['backend'] })
        ]
      })
      useUIStore.setState({ searchQuery: 'front' })

      const { result } = renderHook(() => useTasks())
      expect(result.current.tasks).toHaveLength(1)
      expect(result.current.tasks[0].id).toBe('t1')
    })
  })

  describe('sorting', () => {
    it('sorts by created_at desc (default)', () => {
      useTaskStore.setState({
        tasks: [
          makeWorkfloTask({ id: 't1', created_at: '2024-06-10T00:00:00Z' }),
          makeWorkfloTask({ id: 't2', created_at: '2024-06-15T00:00:00Z' })
        ]
      })

      const { result } = renderHook(() => useTasks())
      expect(result.current.tasks[0].id).toBe('t2')
    })

    it('sorts by priority', () => {
      useTaskStore.setState({
        tasks: [
          makeWorkfloTask({ id: 't1', priority: 'low' }),
          makeWorkfloTask({ id: 't2', priority: 'critical' })
        ]
      })
      useUIStore.setState({ sortField: 'priority', sortDirection: 'asc' })

      const { result } = renderHook(() => useTasks())
      expect(result.current.tasks[0].id).toBe('t2')
    })

    it('sorts by title', () => {
      useTaskStore.setState({
        tasks: [
          makeWorkfloTask({ id: 't1', title: 'Zebra' }),
          makeWorkfloTask({ id: 't2', title: 'Apple' })
        ]
      })
      useUIStore.setState({ sortField: 'title', sortDirection: 'asc' })

      const { result } = renderHook(() => useTasks())
      expect(result.current.tasks[0].id).toBe('t2')
    })

    it('sorts by due_date with nulls last', () => {
      useTaskStore.setState({
        tasks: [
          makeWorkfloTask({ id: 't1', due_date: null }),
          makeWorkfloTask({ id: 't2', due_date: '2024-06-15' }),
          makeWorkfloTask({ id: 't3', due_date: '2024-06-10' })
        ]
      })
      useUIStore.setState({ sortField: 'due_date', sortDirection: 'asc' })

      const { result } = renderHook(() => useTasks())
      expect(result.current.tasks[0].id).toBe('t3')
      expect(result.current.tasks[1].id).toBe('t2')
      expect(result.current.tasks[2].id).toBe('t1')
    })

    it('sorts by status', () => {
      useTaskStore.setState({
        tasks: [
          makeWorkfloTask({ id: 't1', status: TaskStatus.Completed }),
          makeWorkfloTask({ id: 't2', status: TaskStatus.AgentWorking })
        ]
      })
      useUIStore.setState({ sortField: 'status', sortDirection: 'asc' })

      const { result } = renderHook(() => useTasks())
      expect(result.current.tasks[0].id).toBe('t2')
    })

    it('respects desc direction', () => {
      useTaskStore.setState({
        tasks: [
          makeWorkfloTask({ id: 't1', title: 'Apple' }),
          makeWorkfloTask({ id: 't2', title: 'Zebra' })
        ]
      })
      useUIStore.setState({ sortField: 'title', sortDirection: 'desc' })

      const { result } = renderHook(() => useTasks())
      expect(result.current.tasks[0].id).toBe('t2')
    })
  })

  describe('selectedTask', () => {
    it('returns undefined when nothing selected', () => {
      useTaskStore.setState({ tasks: [makeWorkfloTask()], selectedTaskId: null })
      const { result } = renderHook(() => useTasks())
      expect(result.current.selectedTask).toBeUndefined()
    })

    it('returns the selected task', () => {
      useTaskStore.setState({
        tasks: [makeWorkfloTask({ id: 't1', title: 'Selected' })],
        selectedTaskId: 't1'
      })
      const { result } = renderHook(() => useTasks())
      expect(result.current.selectedTask?.id).toBe('t1')
    })
  })
})
