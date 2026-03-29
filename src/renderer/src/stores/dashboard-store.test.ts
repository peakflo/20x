import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useDashboardStore } from './dashboard-store'
import type { ApplicationItem, DashboardStats } from './dashboard-store'

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

describe('useDashboardStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDashboardStore.setState({
      applications: [],
      stats: null,
      timeWindow: '7d',
      applicationsLoading: false,
      statsLoading: false,
      applicationsError: null,
      statsError: null
    })
  })

  it('has correct initial state', () => {
    const state = useDashboardStore.getState()
    expect(state.applications).toEqual([])
    expect(state.stats).toBeNull()
    expect(state.timeWindow).toBe('7d')
    expect(state.applicationsLoading).toBe(false)
    expect(state.statsLoading).toBe(false)
  })

  it('setTimeWindow updates window and re-fetches stats', async () => {
    mockApiRequest.mockResolvedValueOnce({ stats: mockStats })

    useDashboardStore.getState().setTimeWindow('30d')

    expect(useDashboardStore.getState().timeWindow).toBe('30d')
    await vi.waitFor(() => {
      expect(mockApiRequest).toHaveBeenCalledWith('GET', '/api/20x/sync/stats?window=30d')
    })
  })

  it('fetchApplications uses lowercase application_trigger', async () => {
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
    // Verify lowercase triggerType value matching NodeType.APPLICATION_TRIGGER enum
    expect(mockApiRequest).toHaveBeenCalledWith('GET', '/api/workflows?triggerType=application_trigger')
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

  it('fetchAll calls applications and stats fetches', async () => {
    mockApiRequest
      .mockResolvedValueOnce({ workflows: [] })
      .mockResolvedValueOnce({ stats: null })

    await useDashboardStore.getState().fetchAll()

    expect(mockApiRequest).toHaveBeenCalledTimes(2)
  })

  it('handles null stats response', async () => {
    mockApiRequest.mockResolvedValueOnce({ stats: null })

    await useDashboardStore.getState().fetchStats()

    const state = useDashboardStore.getState()
    expect(state.stats).toBeNull()
    expect(state.statsLoading).toBe(false)
  })
})
