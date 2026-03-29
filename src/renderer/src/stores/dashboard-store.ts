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

export type TimeWindow = '24h' | '7d' | '30d' | 'all'

interface DashboardState {
  // Data
  applications: ApplicationItem[]
  stats: DashboardStats | null
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
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  applications: [],
  stats: null,
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
