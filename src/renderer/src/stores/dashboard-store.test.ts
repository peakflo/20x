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
    disableIframeAuth: vi.fn().mockResolvedValue(undefined),
    login: vi.fn(),
    selectTenant: vi.fn(),
    logout: vi.fn(),
    getSession: vi.fn().mockResolvedValue({ isAuthenticated: false }),
    refreshToken: vi.fn(),
    getAuthTokens: vi.fn(),
    listCompanies: vi.fn()
  }
}))

import { enterpriseApi } from '@/lib/ipc-client'
import { useEnterpriseStore } from '@/stores/enterprise-store'

const mockApiRequest = vi.mocked(enterpriseApi.apiRequest)
const mockEnableIframeAuth = vi.mocked(enterpriseApi.enableIframeAuth)

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
      openTabs: [],
      activeTabId: null,
      expandedView: false,
      applicationsLoading: false,
      presetupLoading: false,
      presetupProvisioning: null,
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

  it('fetchApplications falls back to id/workspace tenant when workflow fields are missing', async () => {
    useEnterpriseStore.setState({
      isAuthenticated: true,
      isLoading: false,
      error: null,
      userEmail: 'test@example.com',
      userId: 'user-1',
      currentTenant: { id: 'tenant-fallback', name: 'Fallback Tenant' },
      availableTenants: null
    })

    mockApiRequest.mockResolvedValueOnce({
      workflows: [{
        id: 'wf-from-id',
        name: 'Workflow with ID only',
        description: null,
        status: 'Active',
        lastRun: null,
        runCount: 0,
        updatedAt: '2026-03-28T10:00:00Z',
        version: 1
      }]
    })

    await useDashboardStore.getState().fetchApplications()

    const state = useDashboardStore.getState()
    expect(state.applications).toHaveLength(1)
    expect(state.applications[0].workflowId).toBe('wf-from-id')
    expect(state.applications[0].tenantId).toBe('tenant-fallback')
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

  it('fetchAll calls applications, presetups, and stats fetches', async () => {
    mockApiRequest
      .mockResolvedValueOnce({ workflows: [] })   // fetchApplications
      .mockResolvedValueOnce({ templates: [] })    // fetchPresetups
      .mockResolvedValueOnce({ stats: null })      // fetchStats

    await useDashboardStore.getState().fetchAll()

    expect(mockApiRequest).toHaveBeenCalledTimes(3)
    expect(mockApiRequest).toHaveBeenCalledWith('GET', '/api/presetup/status')
  })

  it('handles null stats response', async () => {
    mockApiRequest.mockResolvedValueOnce({ stats: null })

    await useDashboardStore.getState().fetchStats()

    const state = useDashboardStore.getState()
    expect(state.stats).toBeNull()
    expect(state.statsLoading).toBe(false)
  })

  it('updateLocalStats computes stats from tasks', () => {
    const now = new Date().toISOString()
    const tasks: WorkfloTask[] = [
      makeTask({ id: 't1', status: TaskStatus.NotStarted }),
      makeTask({ id: 't2', status: TaskStatus.Completed, updated_at: now }),
      makeTask({ id: 't3', status: TaskStatus.AgentWorking, agent_id: 'agent-1' }),
      makeTask({ id: 't4', status: TaskStatus.Completed, agent_id: 'agent-1', updated_at: now })
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

describe('auth error detection', () => {
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
    useEnterpriseStore.setState({
      isAuthenticated: true,
      isLoading: false,
      error: null,
      userEmail: 'test@example.com',
      userId: 'user-1',
      currentTenant: { id: 't1', name: 'Test' },
      availableTenants: null
    })
  })

  it('fetchApplications refreshes enterprise session on "sign in again" error', async () => {
    const loadSessionSpy = vi.fn()
    useEnterpriseStore.setState({ loadSession: loadSessionSpy })
    mockApiRequest.mockRejectedValueOnce(new Error('No refresh token available — please sign in again'))

    await useDashboardStore.getState().fetchApplications()

    expect(loadSessionSpy).toHaveBeenCalledOnce()
    expect(useDashboardStore.getState().applicationsError).toContain('sign in again')
  })

  it('fetchStats refreshes enterprise session on "Session expired" error', async () => {
    const loadSessionSpy = vi.fn()
    useEnterpriseStore.setState({ loadSession: loadSessionSpy })
    mockApiRequest.mockRejectedValueOnce(new Error('Session expired — please sign in again'))

    await useDashboardStore.getState().fetchStats()

    expect(loadSessionSpy).toHaveBeenCalledOnce()
    expect(useDashboardStore.getState().statsError).toContain('Session expired')
  })

  it('fetchApplications does NOT refresh session on non-auth error', async () => {
    const loadSessionSpy = vi.fn()
    useEnterpriseStore.setState({ loadSession: loadSessionSpy })
    mockApiRequest.mockRejectedValueOnce(new Error('Network error'))

    await useDashboardStore.getState().fetchApplications()

    expect(loadSessionSpy).not.toHaveBeenCalled()
    expect(useDashboardStore.getState().applicationsError).toBe('Network error')
  })

  it('fetchStats does NOT refresh session on non-auth error', async () => {
    const loadSessionSpy = vi.fn()
    useEnterpriseStore.setState({ loadSession: loadSessionSpy })
    mockApiRequest.mockRejectedValueOnce(new Error('Server error'))

    await useDashboardStore.getState().fetchStats()

    expect(loadSessionSpy).not.toHaveBeenCalled()
    expect(useDashboardStore.getState().statsError).toBe('Server error')
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

  it('excludes recurring parent template tasks from counts', () => {
    const tasks: WorkfloTask[] = [
      makeTask({ id: 'normal', status: TaskStatus.NotStarted }),
      makeTask({ id: 'template', status: TaskStatus.NotStarted, is_recurring: true, recurrence_parent_id: null }),
      makeTask({ id: 'instance', status: TaskStatus.NotStarted, is_recurring: false, recurrence_parent_id: 'template' })
    ]

    const stats = computeLocalStats(tasks, 'all')

    // Template should be excluded; normal + instance should be counted
    expect(stats.totalTasks).toBe(2)
  })

  it('sets single-user defaults', () => {
    const stats = computeLocalStats([], 'all')

    expect(stats.activeUsers).toBe(1)
    expect(stats.totalUsers).toBe(1)
    expect(stats.adoptionRate).toBeNull()
  })
})

describe('tab management', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDashboardStore.setState({
      applications: mockApplications,
      openTabs: [],
      activeTabId: null,
      expandedView: false,
      applicationsLoading: false,
      applicationsError: null,
      stats: null,
      localStats: null,
      timeWindow: '7d',
      presetupLoading: false,
      presetupProvisioning: null,
      statsLoading: false,
      statsError: null
    })
  })

  it('openApplication creates a tab and sets activeTabId by workflowId', async () => {
    mockApiRequest
      .mockResolvedValueOnce({ executionId: 'exec-1' }) // execute/ui
      .mockResolvedValueOnce({ id: 'exec-1', status: 'running', steps: [] }) // poll

    // Don't await — openApplication starts async polling
    const promise = useDashboardStore.getState().openApplication('wf-1')

    // Tab should be created immediately (before any await)
    const state = useDashboardStore.getState()
    expect(state.openTabs).toHaveLength(1)
    expect(state.openTabs[0].workflowId).toBe('wf-1')
    expect(state.activeTabId).toBe('wf-1')
    expect(state.expandedView).toBe(true)

    await promise
  })

  it('openApplication does not execute when tenantId is missing', async () => {
    useDashboardStore.setState({
      applications: [{
        workflowId: 'wf-no-tenant',
        tenantId: '',
        name: 'No tenant app',
        description: null,
        status: 'Active',
        lastRun: null,
        runCount: 0,
        updatedAt: '2026-03-28T10:00:00Z',
        version: 1
      }]
    })
    useEnterpriseStore.setState({
      isAuthenticated: true,
      isLoading: false,
      error: null,
      userEmail: 'test@example.com',
      userId: 'user-1',
      currentTenant: null,
      availableTenants: null
    })

    await useDashboardStore.getState().openApplication('wf-no-tenant')

    expect(mockEnableIframeAuth).not.toHaveBeenCalled()
    expect(mockApiRequest).not.toHaveBeenCalled()
    const state = useDashboardStore.getState()
    expect(state.openTabs).toHaveLength(1)
    expect(state.openTabs[0].error).toContain('Tenant ID is required')
  })

  it('openApplication switches to existing tab by workflowId without creating a duplicate', async () => {
    // Pre-populate with an open tab
    useDashboardStore.setState({
      openTabs: [{ workflowId: 'wf-1', url: 'http://app1.test', executing: false, polling: false, error: null, executionStatus: 'completed' }],
      activeTabId: 'wf-1',
      expandedView: true
    })

    // Open a second tab
    mockApiRequest
      .mockResolvedValueOnce({ executionId: 'exec-2' })
      .mockResolvedValueOnce({ id: 'exec-2', status: 'running', steps: [] })

    const promise = useDashboardStore.getState().openApplication('wf-2')

    let state = useDashboardStore.getState()
    expect(state.openTabs).toHaveLength(2)
    expect(state.activeTabId).toBe('wf-2')

    await promise

    // Now re-open wf-1 — should NOT create a new tab, just switch
    await useDashboardStore.getState().openApplication('wf-1')

    state = useDashboardStore.getState()
    expect(state.openTabs).toHaveLength(2) // still 2, not 3
    expect(state.activeTabId).toBe('wf-1')
  })

  it('switchTab changes activeTabId by workflowId only', () => {
    useDashboardStore.setState({
      openTabs: [
        { workflowId: 'wf-1', url: 'http://app1.test', executing: false, polling: false, error: null, executionStatus: null },
        { workflowId: 'wf-2', url: 'http://app2.test', executing: false, polling: false, error: null, executionStatus: null }
      ],
      activeTabId: 'wf-1',
      expandedView: true
    })

    useDashboardStore.getState().switchTab('wf-2')

    const state = useDashboardStore.getState()
    expect(state.activeTabId).toBe('wf-2')
    // Tabs array should be unchanged
    expect(state.openTabs).toHaveLength(2)
    expect(state.openTabs[0].workflowId).toBe('wf-1')
    expect(state.openTabs[1].workflowId).toBe('wf-2')
  })

  it('switchTab back and forth preserves all tab state', () => {
    useDashboardStore.setState({
      openTabs: [
        { workflowId: 'wf-1', url: 'http://app1.test', executing: false, polling: false, error: null, executionStatus: null },
        { workflowId: 'wf-2', url: 'http://app2.test', executing: false, polling: false, error: null, executionStatus: null }
      ],
      activeTabId: 'wf-1',
      expandedView: true
    })

    // Switch to wf-2
    useDashboardStore.getState().switchTab('wf-2')
    expect(useDashboardStore.getState().activeTabId).toBe('wf-2')

    // Switch back to wf-1
    useDashboardStore.getState().switchTab('wf-1')
    expect(useDashboardStore.getState().activeTabId).toBe('wf-1')

    // Both tabs should still have their original URLs
    const { openTabs } = useDashboardStore.getState()
    expect(openTabs[0].url).toBe('http://app1.test')
    expect(openTabs[1].url).toBe('http://app2.test')
  })

  it('closeTab removes tab and switches activeTabId to remaining tab', () => {
    useDashboardStore.setState({
      openTabs: [
        { workflowId: 'wf-1', url: 'http://app1.test', executing: false, polling: false, error: null, executionStatus: null },
        { workflowId: 'wf-2', url: 'http://app2.test', executing: false, polling: false, error: null, executionStatus: null }
      ],
      activeTabId: 'wf-1',
      expandedView: true
    })

    useDashboardStore.getState().closeTab('wf-1')

    const state = useDashboardStore.getState()
    expect(state.openTabs).toHaveLength(1)
    expect(state.openTabs[0].workflowId).toBe('wf-2')
    expect(state.activeTabId).toBe('wf-2')
    expect(state.expandedView).toBe(true) // still expanded, one tab left
  })

  it('closeTab on inactive tab preserves activeTabId', () => {
    useDashboardStore.setState({
      openTabs: [
        { workflowId: 'wf-1', url: 'http://app1.test', executing: false, polling: false, error: null, executionStatus: null },
        { workflowId: 'wf-2', url: 'http://app2.test', executing: false, polling: false, error: null, executionStatus: null }
      ],
      activeTabId: 'wf-2',
      expandedView: true
    })

    useDashboardStore.getState().closeTab('wf-1')

    const state = useDashboardStore.getState()
    expect(state.openTabs).toHaveLength(1)
    expect(state.activeTabId).toBe('wf-2') // unchanged
  })

  it('closeTab last tab sets expandedView false in single set call', () => {
    useDashboardStore.setState({
      openTabs: [
        { workflowId: 'wf-1', url: 'http://app1.test', executing: false, polling: false, error: null, executionStatus: null }
      ],
      activeTabId: 'wf-1',
      expandedView: true
    })

    useDashboardStore.getState().closeTab('wf-1')

    const state = useDashboardStore.getState()
    expect(state.openTabs).toHaveLength(0)
    expect(state.activeTabId).toBeNull()
    expect(state.expandedView).toBe(false)
  })

  it('tab-content correlation uses workflowId only, not array position', () => {
    // Simulate: open wf-2 first, then wf-1 — order in openTabs differs from applications order
    useDashboardStore.setState({
      openTabs: [
        { workflowId: 'wf-2', url: 'http://app2.test', executing: false, polling: false, error: null, executionStatus: null },
        { workflowId: 'wf-1', url: 'http://app1.test', executing: false, polling: false, error: null, executionStatus: null }
      ],
      activeTabId: 'wf-2',
      expandedView: true
    })

    // Switch to wf-1 (which is at index 1 in openTabs but index 0 in applications)
    useDashboardStore.getState().switchTab('wf-1')

    const state = useDashboardStore.getState()
    expect(state.activeTabId).toBe('wf-1')

    // The active tab content should be wf-1 — verify by checking openTabs lookup
    const activeTab = state.openTabs.find((t) => t.workflowId === state.activeTabId)
    expect(activeTab).toBeDefined()
    expect(activeTab!.workflowId).toBe('wf-1')
    expect(activeTab!.url).toBe('http://app1.test')
  })

  it('minimizeToCards preserves openTabs state', () => {
    useDashboardStore.setState({
      openTabs: [
        { workflowId: 'wf-1', url: 'http://app1.test', executing: false, polling: false, error: null, executionStatus: null }
      ],
      activeTabId: 'wf-1',
      expandedView: true
    })

    useDashboardStore.getState().minimizeToCards()

    const state = useDashboardStore.getState()
    expect(state.expandedView).toBe(false)
    // Tabs should still exist so re-expanding doesn't lose iframes
    expect(state.openTabs).toHaveLength(1)
    expect(state.activeTabId).toBe('wf-1')
  })
})
