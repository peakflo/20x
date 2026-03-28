import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useDashboardStore } from './dashboard-store'
import type { ApplicationItem, DashboardStats, DashboardTask } from './dashboard-store'

// Mock the ipc-client enterprise API
vi.mock('@/lib/ipc-client', () => ({
  enterpriseApi: {
    apiRequest: vi.fn()
  }
}))

import { enterpriseApi } from '@/lib/ipc-client'

const mockApiRequest = vi.mocked(enterpriseApi.apiRequest)

const mockApplications: ApplicationItem[] = [
  {
    workflowId: 'wf-1',
    tenantId: 'tenant-1',
    name: 'AI Accountant',
    description: 'Automated accounting workflow',
    status: 'Active',
    lastRun: '2026-03-28T10:00:00Z',
    runCount: 42,
    updatedAt: '2026-03-28T10:00:00Z',
    version: 3
  },
  {
    workflowId: 'wf-2',
    tenantId: 'tenant-1',
    name: 'AI SDR',
    description: null,
    status: 'Draft',
    lastRun: null,
    runCount: 0,
    updatedAt: '2026-03-27T08:00:00Z',
    version: 1
  }
]

const mockStats: DashboardStats = {
  totalTasks: 150,
  tasksByStatus: { pending: 30, in_progress: 20, completed: 80, cancelled: 10, expired: 10 },
  tasksCreatedInWindow: 25,
  tasksCompletedInWindow: 18,
  avgTaskCompletionTimeHours: 4.5,
  p50CompletionTimeHours: 3.0,
  p90CompletionTimeHours: 8.2,
  totalAgentRuns: 200,
  agentSuccessRate: 92.5,
  autonomousTasksCompleted: 60,
  humanReviewedTasksCompleted: 20,
  aiAutonomyRate: 75.0,
  activeUsers: 5,
  totalUsers: 12,
  adoptionRate: 41.7
}

const mockTasks: DashboardTask[] = [
  {
    id: 'task-1',
    title: 'Review invoice #1234',
    description: 'Check amounts match PO',
    status: 'pending',
    priority: 'high',
    dueDate: '2026-03-30T00:00:00Z',
    assignees: [{ assigneeType: 'email', assigneeValue: 'user@example.com' }],
    createdAt: '2026-03-28T08:00:00Z',
    updatedAt: '2026-03-28T08:00:00Z'
  },
  {
    id: 'task-2',
    title: 'Process payment batch',
    description: null,
    status: 'in_progress',
    priority: 'medium',
    dueDate: null,
    assignees: [],
    createdAt: '2026-03-27T10:00:00Z',
    updatedAt: '2026-03-28T09:00:00Z'
  },
  {
    id: 'task-3',
    title: 'Completed reconciliation',
    description: 'Done',
    status: 'completed',
    priority: 'low',
    dueDate: null,
    assignees: [],
    createdAt: '2026-03-26T10:00:00Z',
    updatedAt: '2026-03-27T15:00:00Z'
  }
]

describe('useDashboardStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDashboardStore.setState({
      applications: [],
      stats: null,
      tasks: [],
      timeWindow: '7d',
      applicationsLoading: false,
      statsLoading: false,
      tasksLoading: false,
      applicationsError: null,
      statsError: null,
      tasksError: null
    })
  })

  it('has correct initial state', () => {
    const state = useDashboardStore.getState()
    expect(state.applications).toEqual([])
    expect(state.stats).toBeNull()
    expect(state.tasks).toEqual([])
    expect(state.timeWindow).toBe('7d')
    expect(state.applicationsLoading).toBe(false)
    expect(state.statsLoading).toBe(false)
    expect(state.tasksLoading).toBe(false)
  })

  it('setTimeWindow updates window and re-fetches stats', async () => {
    mockApiRequest.mockResolvedValueOnce({ stats: mockStats })

    useDashboardStore.getState().setTimeWindow('30d')

    expect(useDashboardStore.getState().timeWindow).toBe('30d')
    // Wait for async fetch to complete
    await vi.waitFor(() => {
      expect(mockApiRequest).toHaveBeenCalledWith('GET', '/api/20x/sync/stats?window=30d')
    })
  })

  it('fetchApplications populates applications list', async () => {
    mockApiRequest.mockResolvedValueOnce({
      workflows: mockApplications.map((a) => ({
        workflowId: a.workflowId,
        name: a.name,
        description: a.description,
        status: a.status,
        lastRun: a.lastRun,
        runCount: a.runCount,
        updatedAt: a.updatedAt,
        version: a.version
      }))
    })

    await useDashboardStore.getState().fetchApplications()

    const state = useDashboardStore.getState()
    expect(state.applications).toHaveLength(2)
    expect(state.applications[0].name).toBe('AI Accountant')
    expect(state.applications[1].name).toBe('AI SDR')
    expect(state.applicationsLoading).toBe(false)
    expect(state.applicationsError).toBeNull()
    expect(mockApiRequest).toHaveBeenCalledWith('GET', '/api/workflows?triggerType=APPLICATION_TRIGGER')
  })

  it('fetchApplications handles errors', async () => {
    mockApiRequest.mockRejectedValueOnce(new Error('Network error'))

    await useDashboardStore.getState().fetchApplications()

    const state = useDashboardStore.getState()
    expect(state.applications).toEqual([])
    expect(state.applicationsLoading).toBe(false)
    expect(state.applicationsError).toBe('Network error')
  })

  it('fetchStats populates stats', async () => {
    mockApiRequest.mockResolvedValueOnce({ stats: mockStats })

    await useDashboardStore.getState().fetchStats()

    const state = useDashboardStore.getState()
    expect(state.stats).toEqual(mockStats)
    expect(state.stats?.totalTasks).toBe(150)
    expect(state.stats?.aiAutonomyRate).toBe(75.0)
    expect(state.statsLoading).toBe(false)
    expect(mockApiRequest).toHaveBeenCalledWith('GET', '/api/20x/sync/stats?window=7d')
  })

  it('fetchTasks populates tasks', async () => {
    mockApiRequest.mockResolvedValueOnce({ tasks: mockTasks })

    await useDashboardStore.getState().fetchTasks()

    const state = useDashboardStore.getState()
    expect(state.tasks).toHaveLength(3)
    expect(state.tasks[0].title).toBe('Review invoice #1234')
    expect(state.tasksLoading).toBe(false)
    expect(mockApiRequest).toHaveBeenCalledWith('GET', '/api/tasks?pageSize=200')
  })

  it('fetchAll calls all three fetch methods', async () => {
    mockApiRequest
      .mockResolvedValueOnce({ workflows: [] })
      .mockResolvedValueOnce({ stats: null })
      .mockResolvedValueOnce({ tasks: [] })

    await useDashboardStore.getState().fetchAll()

    expect(mockApiRequest).toHaveBeenCalledTimes(3)
  })

  it('handles null stats response', async () => {
    mockApiRequest.mockResolvedValueOnce({ stats: null })

    await useDashboardStore.getState().fetchStats()

    const state = useDashboardStore.getState()
    expect(state.stats).toBeNull()
    expect(state.statsLoading).toBe(false)
  })

  it('handles empty tasks array', async () => {
    mockApiRequest.mockResolvedValueOnce({ tasks: [] })

    await useDashboardStore.getState().fetchTasks()

    const state = useDashboardStore.getState()
    expect(state.tasks).toEqual([])
    expect(state.tasksLoading).toBe(false)
  })
})
