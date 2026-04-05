import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useDashboardStore, computeLocalStats } from './dashboard-store'
import type { ApplicationItem, DashboardStats } from './dashboard-store'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'

// Mock the ipc-client enterprise API
vi.mock('@/lib/ipc-client', () => ({
  enterpriseApi: {
    apiRequest: vi.fn(),
    getApiUrl: vi.fn().mockResolvedValue('http://localhost:2000'),
    getJwt: vi.fn().mockResolvedValue('mock-jwt-token'),
    enableIframeAuth: vi.fn().mockResolvedValue({ apiUrl: 'http://localhost:2000' }),
    disableIframeAuth: vi.fn().mockResolvedValue(undefined)
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

function makeTask(overrides: Partial<WorkfloTask> = {}): WorkfloTask {
  return {
    id: 'task-1',
    title: 'Test task',
    description: '',
    type: 'general',
    priority: 'medium',
    status: TaskStatus.NotStarted,
    assignee: '',
    due_date: null,
    labels: [],
    attachments: [],
    repos: [],
    output_fields: [],
    agent_id: null,
    session_id: null,
    external_id: null,
    source_id: null,
    source: 'local',
    skill_ids: null,
    snoozed_until: null,
    resolution: null,
    feedback_rating: null,
    feedback_comment: null,
    is_recurring: false,
    recurrence_pattern: null,
    recurrence_parent_id: null,
    last_occurrence_at: null,
    next_occurrence_at: null,
    parent_task_id: null,
    sort_order: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides
  }
}

describe('useDashboardStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDashboardStore.setState({
      applications: [],
      stats: null,
      localStats: null,
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
    expect(state.localStats).toBeNull()
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

  it('updateLocalStats computes stats from tasks', () => {
    const tasks: WorkfloTask[] = [
      makeTask({ id: 't1', status: TaskStatus.NotStarted }),
      makeTask({ id: 't2', status: TaskStatus.Completed }),
      makeTask({ id: 't3', status: TaskStatus.AgentWorking, agent_id: 'agent-1' }),
      makeTask({ id: 't4', status: TaskStatus.Completed, agent_id: 'agent-1' })
    ]

    useDashboardStore.getState().updateLocalStats(tasks)

    const { localStats } = useDashboardStore.getState()
    expect(localStats).not.toBeNull()
    expect(localStats!.totalTasks).toBe(4)
    expect(localStats!.tasksCompletedInWindow).toBe(2)
    expect(localStats!.totalAgentRuns).toBe(2)
    expect(localStats!.autonomousTasksCompleted).toBe(1)
    expect(localStats!.humanReviewedTasksCompleted).toBe(1)
  })

  it('updateLocalStats excludes subtasks', () => {
    const tasks: WorkfloTask[] = [
      makeTask({ id: 'parent', status: TaskStatus.NotStarted }),
      makeTask({ id: 'sub-1', status: TaskStatus.NotStarted, parent_task_id: 'parent' })
    ]

    useDashboardStore.getState().updateLocalStats(tasks)

    const { localStats } = useDashboardStore.getState()
    expect(localStats!.totalTasks).toBe(1)
  })
})

describe('computeLocalStats', () => {
  it('computes basic counts from tasks', () => {
    const tasks: WorkfloTask[] = [
      makeTask({ id: 't1', status: TaskStatus.NotStarted }),
      makeTask({ id: 't2', status: TaskStatus.Completed }),
      makeTask({ id: 't3', status: TaskStatus.AgentWorking })
    ]

    const stats = computeLocalStats(tasks, 'all')

    expect(stats.totalTasks).toBe(3)
    expect(stats.tasksCompletedInWindow).toBe(1)
    expect(stats.tasksByStatus).toEqual({
      not_started: 1,
      completed: 1,
      agent_working: 1
    })
  })

  it('filters by time window for created tasks', () => {
    const now = new Date()
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString()
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString()

    const tasks: WorkfloTask[] = [
      makeTask({ id: 't1', created_at: twoDaysAgo, updated_at: twoDaysAgo }),
      makeTask({ id: 't2', created_at: tenDaysAgo, updated_at: tenDaysAgo })
    ]

    const stats24h = computeLocalStats(tasks, '24h')
    expect(stats24h.tasksCreatedInWindow).toBe(0)

    const stats7d = computeLocalStats(tasks, '7d')
    expect(stats7d.tasksCreatedInWindow).toBe(1)

    const stats30d = computeLocalStats(tasks, '30d')
    expect(stats30d.tasksCreatedInWindow).toBe(2)
  })

  it('computes AI autonomy rate correctly', () => {
    const tasks: WorkfloTask[] = [
      makeTask({ id: 't1', status: TaskStatus.Completed, agent_id: 'agent-1' }),
      makeTask({ id: 't2', status: TaskStatus.Completed, agent_id: 'agent-1' }),
      makeTask({ id: 't3', status: TaskStatus.Completed, agent_id: null })
    ]

    const stats = computeLocalStats(tasks, 'all')

    expect(stats.aiAutonomyRate).toBeCloseTo(66.7, 1)
    expect(stats.autonomousTasksCompleted).toBe(2)
    expect(stats.humanReviewedTasksCompleted).toBe(1)
  })

  it('computes agent success rate correctly', () => {
    const tasks: WorkfloTask[] = [
      makeTask({ id: 't1', status: TaskStatus.Completed, agent_id: 'agent-1' }),
      makeTask({ id: 't2', status: TaskStatus.AgentWorking, agent_id: 'agent-1' }),
      makeTask({ id: 't3', status: TaskStatus.NotStarted, agent_id: 'agent-1' })
    ]

    const stats = computeLocalStats(tasks, 'all')

    expect(stats.agentSuccessRate).toBeCloseTo(33.3, 1)
    expect(stats.totalAgentRuns).toBe(3)
  })

  it('returns null rates when no tasks', () => {
    const stats = computeLocalStats([], 'all')

    expect(stats.totalTasks).toBe(0)
    expect(stats.aiAutonomyRate).toBeNull()
    expect(stats.agentSuccessRate).toBeNull()
    expect(stats.avgTaskCompletionTimeHours).toBeNull()
  })

  it('excludes subtasks from counts', () => {
    const tasks: WorkfloTask[] = [
      makeTask({ id: 'parent', status: TaskStatus.NotStarted }),
      makeTask({ id: 'sub-1', status: TaskStatus.Completed, parent_task_id: 'parent' }),
      makeTask({ id: 'sub-2', status: TaskStatus.Completed, parent_task_id: 'parent' })
    ]

    const stats = computeLocalStats(tasks, 'all')

    expect(stats.totalTasks).toBe(1)
    expect(stats.tasksCompletedInWindow).toBe(0) // Only parent counted, which is not_started
  })

  it('excludes snoozed tasks from counts', () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const tasks: WorkfloTask[] = [
      makeTask({ id: 'active', status: TaskStatus.NotStarted }),
      makeTask({ id: 'snoozed-future', status: TaskStatus.NotStarted, snoozed_until: futureDate }),
      makeTask({ id: 'snoozed-someday', status: TaskStatus.AgentWorking, snoozed_until: '9999-12-31T00:00:00.000Z' }),
      makeTask({ id: 'snoozed-expired', status: TaskStatus.NotStarted, snoozed_until: pastDate })
    ]

    const stats = computeLocalStats(tasks, 'all')

    // Only active + expired-snooze should be counted (2 tasks)
    expect(stats.totalTasks).toBe(2)
    expect(stats.tasksByStatus[TaskStatus.NotStarted]).toBe(2)
    expect(stats.tasksByStatus[TaskStatus.AgentWorking]).toBeUndefined()
  })

  it('sets single-user defaults', () => {
    const stats = computeLocalStats([], 'all')

    expect(stats.activeUsers).toBe(1)
    expect(stats.totalUsers).toBe(1)
    expect(stats.adoptionRate).toBeNull()
  })
})
