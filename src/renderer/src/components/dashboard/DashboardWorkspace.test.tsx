import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { DashboardWorkspace } from './DashboardWorkspace'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useEnterpriseStore } from '@/stores/enterprise-store'

// Mock ipc-client - prevent real API calls during tests
vi.mock('@/lib/ipc-client', () => ({
  enterpriseApi: {
    apiRequest: vi.fn().mockResolvedValue({}),
    login: vi.fn(),
    selectTenant: vi.fn(),
    logout: vi.fn(),
    getSession: vi.fn().mockResolvedValue({ isAuthenticated: false }),
    refreshToken: vi.fn()
  }
}))

afterEach(cleanup)

beforeEach(() => {
  // Reset store with fetchAll as a no-op so useEffect doesn't overwrite pre-set data
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
    tasksError: null,
    fetchAll: vi.fn()
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
})

describe('DashboardWorkspace', () => {
  it('shows connect prompt when not authenticated', () => {
    render(<DashboardWorkspace />)
    expect(screen.getByText('Connect to 20x Cloud')).toBeDefined()
    expect(screen.getByText(/Sign in to your enterprise account/)).toBeDefined()
  })

  it('renders dashboard sections when authenticated', () => {
    useEnterpriseStore.setState({ isAuthenticated: true })

    render(<DashboardWorkspace />)
    expect(screen.getByText('Dashboard')).toBeDefined()
    expect(screen.getByText('Stats Overview')).toBeDefined()
    expect(screen.getByText('Applications')).toBeDefined()
    expect(screen.getByText('Task Board')).toBeDefined()
  })

  it('renders time window selector buttons', () => {
    useEnterpriseStore.setState({ isAuthenticated: true })

    render(<DashboardWorkspace />)
    expect(screen.getByText('24h')).toBeDefined()
    expect(screen.getByText('7d')).toBeDefined()
    expect(screen.getByText('30d')).toBeDefined()
    expect(screen.getByText('All')).toBeDefined()
  })

  it('shows stats values when data is loaded', () => {
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
    expect(screen.getByText('75.0%')).toBeDefined()
    expect(screen.getByText('92.5%')).toBeDefined()
    expect(screen.getByText('150')).toBeDefined()
  })

  it('shows empty state for applications when no data', () => {
    useEnterpriseStore.setState({ isAuthenticated: true })

    render(<DashboardWorkspace />)
    expect(screen.getByText(/No applications found/)).toBeDefined()
  })

  it('shows empty state for task board when no data', () => {
    useEnterpriseStore.setState({ isAuthenticated: true })

    render(<DashboardWorkspace />)
    expect(screen.getByText(/No tasks found/)).toBeDefined()
  })

  it('renders application cards when data is loaded', () => {
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
    expect(screen.getByText('Automated accounting')).toBeDefined()
    expect(screen.getByText('Active')).toBeDefined()
  })

  it('renders task board columns with task cards', () => {
    useEnterpriseStore.setState({ isAuthenticated: true })
    useDashboardStore.setState({
      tasks: [
        {
          id: 'task-1',
          title: 'Review invoice',
          description: null,
          status: 'pending',
          priority: 'high',
          dueDate: null,
          assignees: [],
          createdAt: '2026-03-28T08:00:00Z',
          updatedAt: '2026-03-28T08:00:00Z'
        },
        {
          id: 'task-2',
          title: 'Process payment',
          description: null,
          status: 'in_progress',
          priority: 'medium',
          dueDate: null,
          assignees: [],
          createdAt: '2026-03-27T10:00:00Z',
          updatedAt: '2026-03-28T09:00:00Z'
        }
      ]
    })

    render(<DashboardWorkspace />)
    // Column headers
    expect(screen.getByText('Pending')).toBeDefined()
    expect(screen.getByText('In Progress')).toBeDefined()
    // Task cards
    expect(screen.getByText('Review invoice')).toBeDefined()
    expect(screen.getByText('Process payment')).toBeDefined()
    expect(screen.getByText('high')).toBeDefined()
  })

  it('shows loading state for applications', () => {
    useEnterpriseStore.setState({ isAuthenticated: true })
    useDashboardStore.setState({ applicationsLoading: true })

    render(<DashboardWorkspace />)
    expect(screen.queryByText(/No applications found/)).toBeNull()
  })

  it('calls fetchAll on mount when authenticated', () => {
    const mockFetchAll = vi.fn()
    useDashboardStore.setState({ fetchAll: mockFetchAll })
    useEnterpriseStore.setState({ isAuthenticated: true })

    render(<DashboardWorkspace />)
    expect(mockFetchAll).toHaveBeenCalledOnce()
  })
})
