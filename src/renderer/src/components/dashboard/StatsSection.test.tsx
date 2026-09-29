import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { StatsSection } from './StatsSection'
import { useDashboardStore, type DashboardStats } from '@/stores/dashboard-store'

afterEach(cleanup)

function makeStats(overrides: Partial<DashboardStats> = {}): DashboardStats {
  return {
    totalTasks: 100,
    tasksByStatus: {},
    tasksCreatedInWindow: 12,
    tasksCompletedInWindow: 8,
    avgTaskCompletionTimeHours: null,
    p50CompletionTimeHours: null,
    p90CompletionTimeHours: null,
    totalAgentRuns: 1234,
    agentSuccessRate: 87.56,
    autonomousTasksCompleted: 45,
    humanReviewedTasksCompleted: 30,
    aiAutonomyRate: 62.34,
    activeUsers: 3,
    totalUsers: 5,
    adoptionRate: null,
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useDashboardStore.setState({
    stats: null,
    localStats: null,
    statsLoading: false
  })
})

describe('StatsSection', () => {
  it('renders the heading and four stat cards', () => {
    render(<StatsSection />)

    expect(screen.getByText('Stats Overview')).toBeDefined()
    expect(screen.getByText('AI Autonomy')).toBeDefined()
    expect(screen.getByText('Agent Success')).toBeDefined()
    expect(screen.getByText('Tasks Created')).toBeDefined()
    expect(screen.getByText('Completed')).toBeDefined()
  })

  it('formats percent values with one decimal', () => {
    useDashboardStore.setState({ stats: makeStats() })

    render(<StatsSection />)

    expect(screen.getByText('62.3%')).toBeDefined()
    expect(screen.getByText('87.6%')).toBeDefined()
  })

  it('shows placeholder dashes when there is no data', () => {
    render(<StatsSection />)

    // 2 percents + 2 numbers = 4 dashes
    expect(screen.getAllByText('--')).toHaveLength(4)
  })

  it('shows counts with locale formatting and descriptions', () => {
    useDashboardStore.setState({ stats: makeStats() })

    render(<StatsSection />)

    expect(screen.getByText('1,234')).toBeDefined()
    expect(screen.getByText('12')).toBeDefined()
    expect(screen.getByText('8')).toBeDefined()
    expect(screen.getByText('45 autonomous')).toBeDefined()
    expect(screen.getByText('1,234 total runs')).toBeDefined()
    expect(screen.getByText('100 total')).toBeDefined()
  })

  it('falls back to localStats when cloud stats are absent', () => {
    useDashboardStore.setState({
      stats: null,
      localStats: makeStats({ tasksCreatedInWindow: 7, totalTasks: 20 })
    })

    render(<StatsSection />)

    expect(screen.getByText('7')).toBeDefined()
    expect(screen.getByText('20 total')).toBeDefined()
  })

  it('prefers cloud stats over localStats', () => {
    useDashboardStore.setState({
      stats: makeStats({ tasksCreatedInWindow: 9 }),
      localStats: makeStats({ tasksCreatedInWindow: 7 })
    })

    render(<StatsSection />)

    expect(screen.getByText('9')).toBeDefined()
    expect(screen.queryByText('7')).toBeNull()
  })

  it('shows skeletons while loading with no data', () => {
    useDashboardStore.setState({ statsLoading: true, stats: null, localStats: null })

    const { container } = render(<StatsSection />)

    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(4)
    expect(screen.queryByText('--')).toBeNull()
  })

  it('keeps showing values while loading when data exists', () => {
    useDashboardStore.setState({ statsLoading: true, stats: makeStats() })

    const { container } = render(<StatsSection />)

    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(0)
    expect(screen.getByText('62.3%')).toBeDefined()
  })

  it('shows empty-state description when no stats have loaded', () => {
    render(<StatsSection />)

    expect(screen.getByText('Tasks without human review')).toBeDefined()
  })
})
