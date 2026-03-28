import { create } from 'zustand'
import { enterpriseApi } from '@/lib/ipc-client'

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

export interface DashboardTask {
  id: string
  title: string
  description: string | null
  status: string
  priority: string
  dueDate: string | null
  assignees: Array<{ assigneeType: string; assigneeValue: string }>
  createdAt: string
  updatedAt: string
  workflowId?: string
  executionId?: string
}

export type TimeWindow = '24h' | '7d' | '30d' | 'all'

interface DashboardState {
  // Data
  applications: ApplicationItem[]
  stats: DashboardStats | null
  tasks: DashboardTask[]
  timeWindow: TimeWindow

  // Loading states
  applicationsLoading: boolean
  statsLoading: boolean
  tasksLoading: boolean

  // Error states
  applicationsError: string | null
  statsError: string | null
  tasksError: string | null

  // Actions
  setTimeWindow: (window: TimeWindow) => void
  fetchApplications: () => Promise<void>
  fetchStats: () => Promise<void>
  fetchTasks: () => Promise<void>
  fetchAll: () => Promise<void>
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
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

  setTimeWindow: (timeWindow) => {
    set({ timeWindow })
    // Re-fetch stats with new window
    get().fetchStats()
  },

  fetchApplications: async () => {
    set({ applicationsLoading: true, applicationsError: null })
    try {
      const result = await enterpriseApi.apiRequest('GET', '/api/workflows?triggerType=APPLICATION_TRIGGER') as {
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

  fetchTasks: async () => {
    set({ tasksLoading: true, tasksError: null })
    try {
      const result = await enterpriseApi.apiRequest('GET', '/api/tasks?pageSize=200') as {
        tasks: DashboardTask[]
      }
      set({ tasks: result.tasks || [], tasksLoading: false })
    } catch (err) {
      set({
        tasksLoading: false,
        tasksError: err instanceof Error ? err.message : 'Failed to fetch tasks'
      })
    }
  },

  fetchAll: async () => {
    const state = get()
    await Promise.allSettled([
      state.fetchApplications(),
      state.fetchStats(),
      state.fetchTasks()
    ])
  }
}))
