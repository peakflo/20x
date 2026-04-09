import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { DashboardWorkspace } from './DashboardWorkspace'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useEnterpriseStore } from '@/stores/enterprise-store'
import { useTaskStore } from '@/stores/task-store'
import { useUIStore } from '@/stores/ui-store'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'

// Mock use-snooze-tick to avoid IPC dependency in tests
vi.mock('@/hooks/use-snooze-tick', () => ({
  useSnoozeTick: () => 0
}))

// Mock ipc-client - prevent real API calls during tests
vi.mock('@/lib/ipc-client', () => ({
  enterpriseApi: {
    apiRequest: vi.fn().mockResolvedValue({}),
    login: vi.fn(),
    selectTenant: vi.fn(),
    logout: vi.fn(),
    getSession: vi.fn().mockResolvedValue({ isAuthenticated: false }),
    refreshToken: vi.fn(),
    getApiUrl: vi.fn().mockResolvedValue('http://localhost:2000'),
    getJwt: vi.fn().mockResolvedValue('mock-jwt-token'),
    enableIframeAuth: vi.fn().mockResolvedValue({ apiUrl: 'http://localhost:2000' }),
    disableIframeAuth: vi.fn().mockResolvedValue(undefined)
  },
  taskApi: {
    getAll: vi.fn().mockResolvedValue([])
  },
  onTaskUpdated: vi.fn(() => () => {}),
  onTaskCreated: vi.fn(() => () => {}),
  onTasksRefresh: vi.fn(() => () => {}),
  taskSourceApi: { sync: vi.fn() }
}))

afterEach(cleanup)

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
    created_at: '2026-03-28T08:00:00Z',
    updated_at: '2026-03-28T08:00:00Z',
    ...overrides
  }
}

beforeEach(() => {
  // Reset dashboard store with fetchAll as a no-op
  useDashboardStore.setState({
    applications: [],
    presetupTemplates: [],
    stats: null,
    localStats: null,
    timeWindow: '7d',
    applicationsLoading: false,
    presetupLoading: false,
    presetupProvisioning: null,
    statsLoading: false,
    applicationsError: null,
    statsError: null,
    fetchAll: vi.fn(),
    updateLocalStats: vi.fn()
  })
  useEnterpriseStore.setState({
    isAuthenticated: false,
    isLoading: false,
    error: null,
    userEmail: null,
    userId: null,
    currentTenant: null,
    availableTenants: null
  })
  useTaskStore.setState({
    tasks: [],
    selectedTaskId: null,
    isLoading: false,
    error: null
  })
})

describe('DashboardWorkspace', () => {
  it('shows connect CTA when not authenticated', () => {
    render(<DashboardWorkspace />)
    expect(screen.getByText('Connect to 20x Cloud')).toBeDefined()
    expect(screen.getByText('Connect')).toBeDefined() // CTA button
  })

  it('always shows stats section even when not authenticated', () => {
    useDashboardStore.setState({
      localStats: {
        totalTasks: 5,
        tasksByStatus: { not_started: 3, completed: 2 },
        tasksCreatedInWindow: 5,
        tasksCompletedInWindow: 2,
        avgTaskCompletionTimeHours: null,
        p50CompletionTimeHours: null,
        p90CompletionTimeHours: null,
        totalAgentRuns: 0,
        agentSuccessRate: null,
        autonomousTasksCompleted: 0,
        humanReviewedTasksCompleted: 2,
        aiAutonomyRate: 0,
        activeUsers: 1,
        totalUsers: 1,
        adoptionRate: null
      }
    })

    render(<DashboardWorkspace />)
    expect(screen.getByText('Stats Overview')).toBeDefined()
    expect(screen.getByText('5')).toBeDefined() // tasksCreatedInWindow
    expect(screen.getByText('Task Board')).toBeDefined()
  })

  it('always shows time window selector', () => {
    render(<DashboardWorkspace />)
    expect(screen.getByText('24h')).toBeDefined()
    expect(screen.getByText('7d')).toBeDefined()
    expect(screen.getByText('30d')).toBeDefined()
    expect(screen.getByText('All')).toBeDefined()
  })

  it('renders dashboard sections when authenticated', () => {
    useEnterpriseStore.setState({ isAuthenticated: true })

    render(<DashboardWorkspace />)
    expect(screen.getByText('Dashboard')).toBeDefined()
    expect(screen.getByText('Stats Overview')).toBeDefined()
    expect(screen.getByText('Task Board')).toBeDefined()
  })

  it('shows stats values when cloud data is loaded', () => {
    useEnterpriseStore.setState({ isAuthenticated: true })
    useDashboardStore.setState({
      stats: {
        totalTasks: 150,
        tasksByStatus: { pending: 30, completed: 80 },
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
    })

    render(<DashboardWorkspace />)
    expect(screen.getByText('75.0%')).toBeDefined() // AI Autonomy
    expect(screen.getByText('92.5%')).toBeDefined() // Agent Success
    expect(screen.getByText('25')).toBeDefined() // Tasks Created (tasksCreatedInWindow)
    expect(screen.getByText('18')).toBeDefined() // Completed (tasksCompletedInWindow)
  })

  it('hides applications section when no data', () => {
    useEnterpriseStore.setState({ isAuthenticated: true })

    render(<DashboardWorkspace />)
    // Applications block should not render at all when empty
    expect(screen.queryByText(/No applications found/)).toBeNull()
    expect(screen.queryByText('Applications')).toBeNull()
  })

  it('renders application tabs when data is loaded', () => {
    useEnterpriseStore.setState({ isAuthenticated: true })
    useDashboardStore.setState({
      applications: [
        {
          workflowId: 'wf-1',
          tenantId: 'tenant-1',
          name: 'AI Accountant',
          description: 'Automated accounting',
          status: 'Active',
          lastRun: '2026-03-28T10:00:00Z',
          runCount: 42,
          updatedAt: '2026-03-28T10:00:00Z',
          version: 3
        }
      ]
    })

    render(<DashboardWorkspace />)
    expect(screen.getByText('AI Accountant')).toBeDefined()
  })

  it('renders task board columns with local 20x tasks', () => {
    useEnterpriseStore.setState({ isAuthenticated: true })
    useTaskStore.setState({
      tasks: [
        makeTask({ id: 'task-1', title: 'Review invoice', status: TaskStatus.NotStarted, priority: 'high' }),
        makeTask({ id: 'task-2', title: 'Process payment', status: TaskStatus.AgentWorking, priority: 'medium' })
      ]
    })

    render(<DashboardWorkspace />)
    // Column headers (20x task statuses)
    expect(screen.getByText('Not Started')).toBeDefined()
    expect(screen.getByText('Agent Working')).toBeDefined()
    // Task cards
    expect(screen.getByText('Review invoice')).toBeDefined()
    expect(screen.getByText('Process payment')).toBeDefined()
    expect(screen.getByText('high')).toBeDefined()
  })

  it('filters out subtasks from the task board', () => {
    useEnterpriseStore.setState({ isAuthenticated: true })
    useTaskStore.setState({
      tasks: [
        makeTask({ id: 'parent-1', title: 'Parent task', status: TaskStatus.NotStarted }),
        makeTask({ id: 'sub-1', title: 'Subtask', status: TaskStatus.NotStarted, parent_task_id: 'parent-1' })
      ]
    })

    render(<DashboardWorkspace />)
    expect(screen.getByText('Parent task')).toBeDefined()
    expect(screen.queryByText('Subtask')).toBeNull()
    // Count shows 1 active task (only parent)
    expect(screen.getByText('1 active task')).toBeDefined()
  })

  it('shows empty task board when no tasks', () => {
    useEnterpriseStore.setState({ isAuthenticated: true })

    render(<DashboardWorkspace />)
    expect(screen.getByText(/No tasks yet/)).toBeDefined()
  })

  it('calls fetchAll on mount when authenticated', () => {
    const mockFetchAll = vi.fn()
    useDashboardStore.setState({ fetchAll: mockFetchAll })
    useEnterpriseStore.setState({ isAuthenticated: true })

    render(<DashboardWorkspace />)
    expect(mockFetchAll).toHaveBeenCalledOnce()
  })

  it('computes local stats on mount even when not authenticated', () => {
    const mockUpdateLocalStats = vi.fn()
    useDashboardStore.setState({ updateLocalStats: mockUpdateLocalStats })
    useTaskStore.setState({
      tasks: [
        makeTask({ id: 'task-1', title: 'Task 1', status: TaskStatus.NotStarted }),
        makeTask({ id: 'task-2', title: 'Task 2', status: TaskStatus.Completed })
      ]
    })

    render(<DashboardWorkspace />)
    expect(mockUpdateLocalStats).toHaveBeenCalled()
  })

  it('hides snoozed tasks from the task board', () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    useTaskStore.setState({
      tasks: [
        makeTask({ id: 'active-1', title: 'Active task', status: TaskStatus.NotStarted }),
        makeTask({ id: 'snoozed-1', title: 'Snoozed task', status: TaskStatus.NotStarted, snoozed_until: futureDate }),
        makeTask({ id: 'snoozed-2', title: 'Someday task', status: TaskStatus.AgentWorking, snoozed_until: '9999-12-31T00:00:00.000Z' })
      ]
    })

    render(<DashboardWorkspace />)
    expect(screen.getByText('Active task')).toBeDefined()
    expect(screen.queryByText('Snoozed task')).toBeNull()
    expect(screen.queryByText('Someday task')).toBeNull()
    // Only 1 active task (snoozed ones are excluded)
    expect(screen.getByText('1 active task')).toBeDefined()
  })

  it('shows tasks whose snooze has expired', () => {
    const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    useTaskStore.setState({
      tasks: [
        makeTask({ id: 'expired-snooze', title: 'Expired snooze task', status: TaskStatus.NotStarted, snoozed_until: pastDate })
      ]
    })

    render(<DashboardWorkspace />)
    expect(screen.getByText('Expired snooze task')).toBeDefined()
  })

  it('shows "New Task" button that opens create modal', () => {
    render(<DashboardWorkspace />)
    const newTaskBtn = screen.getByText('New Task')
    expect(newTaskBtn).toBeDefined()

    fireEvent.click(newTaskBtn)
    expect(useUIStore.getState().activeModal).toBe('create')
  })

  it('clicking a task card sets dashboardPreviewTaskId in UI store', () => {
    useTaskStore.setState({
      tasks: [
        makeTask({ id: 'task-abc', title: 'Clickable task', status: TaskStatus.NotStarted })
      ]
    })

    render(<DashboardWorkspace />)
    fireEvent.click(screen.getByText('Clickable task'))

    // Should set the preview task ID in the UI store (dialog rendered by AppLayout)
    expect(useUIStore.getState().dashboardPreviewTaskId).toBe('task-abc')
  })
})
