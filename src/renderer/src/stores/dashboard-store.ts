import { create } from 'zustand'
import { enterpriseApi } from '@/lib/ipc-client'
import type { WorkfloTask } from '@/types'
import { TaskStatus } from '@/types'

// ── Types ───────────────────────────────────────────────────

export interface ApplicationItem {
  workflowId: string
  tenantId: string
  name: string
  description: string | null
  status: string
  lastRun: string | null
  runCount: number
  updatedAt: string
  version: number
}

export interface DashboardStats {
  totalTasks: number
  tasksByStatus: Record<string, number>
  tasksCreatedInWindow: number
  tasksCompletedInWindow: number
  avgTaskCompletionTimeHours: number | null
  p50CompletionTimeHours: number | null
  p90CompletionTimeHours: number | null
  totalAgentRuns: number
  agentSuccessRate: number | null
  autonomousTasksCompleted: number
  humanReviewedTasksCompleted: number
  aiAutonomyRate: number | null
  activeUsers: number
  totalUsers: number
  adoptionRate: number | null
}

export type TimeWindow = '24h' | '7d' | '30d' | 'all'

// ── Local stats computation ─────────────────────────────────

function getWindowStart(timeWindow: TimeWindow): Date | null {
  if (timeWindow === 'all') return null
  const now = new Date()
  switch (timeWindow) {
    case '24h':
      return new Date(now.getTime() - 24 * 60 * 60 * 1000)
    case '7d':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    case '30d':
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  }
}

/** Compute dashboard stats from local tasks (no cloud required). */
export function computeLocalStats(tasks: WorkfloTask[], timeWindow: TimeWindow): DashboardStats {
  // Filter to top-level tasks only (consistent with TaskBoard)
  const topLevel = tasks.filter((t) => !t.parent_task_id)
  const windowStart = getWindowStart(timeWindow)

  const tasksByStatus: Record<string, number> = {}
  for (const t of topLevel) {
    const s = t.status || TaskStatus.NotStarted
    tasksByStatus[s] = (tasksByStatus[s] || 0) + 1
  }

  const tasksCreatedInWindow = windowStart
    ? topLevel.filter((t) => new Date(t.created_at) >= windowStart).length
    : topLevel.length

  const completedTasks = topLevel.filter((t) => t.status === TaskStatus.Completed)
  const tasksCompletedInWindow = windowStart
    ? completedTasks.filter((t) => new Date(t.updated_at) >= windowStart).length
    : completedTasks.length

  // Agent-related tasks (tasks that have/had an agent assigned)
  const agentTasks = topLevel.filter((t) => t.agent_id)
  const agentCompletedTasks = agentTasks.filter((t) => t.status === TaskStatus.Completed)

  return {
    totalTasks: topLevel.length,
    tasksByStatus,
    tasksCreatedInWindow,
    tasksCompletedInWindow,
    // Completion time can't be computed locally (no completed_at timestamp)
    avgTaskCompletionTimeHours: null,
    p50CompletionTimeHours: null,
    p90CompletionTimeHours: null,
    totalAgentRuns: agentTasks.length,
    agentSuccessRate: agentTasks.length > 0
      ? (agentCompletedTasks.length / agentTasks.length) * 100
      : null,
    autonomousTasksCompleted: agentCompletedTasks.length,
    humanReviewedTasksCompleted: completedTasks.length - agentCompletedTasks.length,
    aiAutonomyRate: completedTasks.length > 0
      ? (agentCompletedTasks.length / completedTasks.length) * 100
      : null,
    activeUsers: 1, // Local is always single-user
    totalUsers: 1,
    adoptionRate: null
  }
}

interface DashboardState {
  // Data
  applications: ApplicationItem[]
  stats: DashboardStats | null
  localStats: DashboardStats | null
  timeWindow: TimeWindow

  // Loading states
  applicationsLoading: boolean
  statsLoading: boolean

  // Error states
  applicationsError: string | null
  statsError: string | null

  // Actions
  setTimeWindow: (window: TimeWindow) => void
  fetchApplications: () => Promise<void>
  fetchStats: () => Promise<void>
  fetchAll: () => Promise<void>
  updateLocalStats: (tasks: WorkfloTask[]) => void
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  applications: [],
  stats: null,
  localStats: null,
  timeWindow: '7d',

  applicationsLoading: false,
  statsLoading: false,

  applicationsError: null,
  statsError: null,

  setTimeWindow: (timeWindow) => {
    set({ timeWindow })
    // Re-fetch stats with new window
    get().fetchStats()
  },

  updateLocalStats: (tasks: WorkfloTask[]) => {
    const { timeWindow } = get()
    set({ localStats: computeLocalStats(tasks, timeWindow) })
  },

  fetchApplications: async () => {
    set({ applicationsLoading: true, applicationsError: null })
    try {
      // Must use lowercase 'application_trigger' to match the NodeType enum value in workflow-builder
      const result = await enterpriseApi.apiRequest('GET', '/api/workflows?triggerType=application_trigger') as {
        workflows: Array<{
          workflowId: string
          tenantId?: string
          name: string
          description: string | null
          status: string
          lastRun: string | null
          runCount: number
          updatedAt: string
          version: number
        }>
      }
      const applications: ApplicationItem[] = (result.workflows || []).map((w) => ({
        workflowId: w.workflowId,
        tenantId: w.tenantId || '',
        name: w.name,
        description: w.description,
        status: w.status || 'Draft',
        lastRun: w.lastRun,
        runCount: w.runCount || 0,
        updatedAt: w.updatedAt,
        version: w.version
      }))
      set({ applications, applicationsLoading: false })
    } catch (err) {
      set({
        applicationsLoading: false,
        applicationsError: err instanceof Error ? err.message : 'Failed to fetch applications'
      })
    }
  },

  fetchStats: async () => {
    set({ statsLoading: true, statsError: null })
    try {
      const { timeWindow } = get()
      const result = await enterpriseApi.apiRequest('GET', `/api/20x/sync/stats?window=${timeWindow}`) as {
        stats: DashboardStats | null
      }
      set({ stats: result.stats, statsLoading: false })
    } catch (err) {
      set({
        statsLoading: false,
        statsError: err instanceof Error ? err.message : 'Failed to fetch stats'
      })
    }
  },

  fetchAll: async () => {
    const state = get()
    await Promise.allSettled([
      state.fetchApplications(),
      state.fetchStats()
    ])
  }
}))
