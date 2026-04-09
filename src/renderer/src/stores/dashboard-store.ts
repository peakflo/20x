import { create } from 'zustand'
import { enterpriseApi } from '@/lib/ipc-client'
import { useEnterpriseStore } from '@/stores/enterprise-store'
import { isSnoozed } from '@/lib/utils'
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

export interface PresetupTemplate {
  slug: string
  name: string
  description: string
  category: string
  icon: string
  isProvisioned: boolean
  provisionedAt: string | null
  provisionStatus: string | null
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
  // Filter to top-level, non-snoozed, non-template tasks only (consistent with TaskBoard)
  const topLevel = tasks.filter((t) => !t.parent_task_id && !isSnoozed(t.snoozed_until) && !(t.is_recurring && !t.recurrence_parent_id))
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

/** Per-tab state for an opened application */
export interface ApplicationTab {
  workflowId: string
  url: string | null
  executing: boolean
  polling: boolean
  error: string | null
  executionStatus: string | null
}

interface DashboardState {
  // Data
  applications: ApplicationItem[]
  presetupTemplates: PresetupTemplate[]
  stats: DashboardStats | null
  localStats: DashboardStats | null
  timeWindow: TimeWindow

  // Multi-tab application state
  openTabs: ApplicationTab[]       // all opened tabs (iframes kept alive)
  activeTabId: string | null       // currently visible tab workflowId
  expandedView: boolean            // true = showing tabs+iframe, false = showing cards

  // Loading states
  applicationsLoading: boolean
  presetupLoading: boolean
  presetupProvisioning: string | null  // slug being provisioned
  statsLoading: boolean

  // Error states
  applicationsError: string | null
  statsError: string | null

  // Actions
  setTimeWindow: (window: TimeWindow) => void
  fetchApplications: () => Promise<void>
  fetchPresetups: () => Promise<void>
  provisionPresetup: (slug: string) => Promise<void>
  fetchStats: () => Promise<void>
  fetchAll: () => Promise<void>
  updateLocalStats: (tasks: WorkfloTask[]) => void
  openApplication: (workflowId: string) => Promise<void>
  switchTab: (workflowId: string) => void
  closeTab: (workflowId: string) => void
  minimizeToCards: () => void
}

// ── Application URL extraction ─────────────────────────────

interface ExecutionStep {
  id: string
  stepName: string
  nodeId: string
  status: string
  stepOutput: Record<string, unknown> | null
  metadata?: Record<string, unknown>
}

interface ExecutionData {
  id: string
  status: string
  steps: ExecutionStep[]
}

function findApplicationUrl(steps: ExecutionStep[]): string | null {
  const isApplicationStep = (step: ExecutionStep): boolean =>
    step.metadata?.nodeType === 'APPLICATION' ||
    step.metadata?.nodeType === 'application' ||
    step.stepName?.toLowerCase().includes('application') ||
    step.nodeId?.toLowerCase().includes('application')

  // Prioritise sandbox/daytona URLs (the actual renderable preview) over the
  // generic 'url' field which may contain a UI deep-link that isn't servable.
  const urlFields = ['sandboxUrl', 'daytonaUrl', 'previewUrl', 'iframeUrl', 'applicationUrl', 'url']

  for (const step of steps) {
    if (!isApplicationStep(step) || !step.stepOutput) continue
    for (const field of urlFields) {
      const value = step.stepOutput[field]
      if (typeof value === 'string' && value.startsWith('http')) return value
    }
    // Check nested sandbox.url
    const sandbox = step.stepOutput.sandbox
    if (
      sandbox &&
      typeof sandbox === 'object' &&
      'url' in sandbox &&
      typeof (sandbox as Record<string, unknown>).url === 'string'
    ) {
      return (sandbox as Record<string, unknown>).url as string
    }
  }
  return null
}

// Helper to update a single tab within openTabs
function updateTab(
  tabs: ApplicationTab[],
  workflowId: string,
  patch: Partial<ApplicationTab>
): ApplicationTab[] {
  return tabs.map((t) => (t.workflowId === workflowId ? { ...t, ...patch } : t))
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  applications: [],
  presetupTemplates: [],
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

  fetchPresetups: async () => {
    set({ presetupLoading: true })
    try {
      const result = await enterpriseApi.apiRequest('GET', '/api/presetup/status') as {
        templates: PresetupTemplate[]
      }
      set({ presetupTemplates: result.templates || [], presetupLoading: false })
    } catch {
      // Silently fail — presetups are optional, don't block the dashboard
      set({ presetupTemplates: [], presetupLoading: false })
    }
  },

  provisionPresetup: async (slug: string) => {
    set({ presetupProvisioning: slug })
    try {
      await enterpriseApi.apiRequest('POST', '/api/presetup/provision', {
        templateSlug: slug
      })
      // Refresh presetup status after provisioning
      await get().fetchPresetups()
    } catch (err) {
      console.error('Failed to provision presetup:', err)
    } finally {
      set({ presetupProvisioning: null })
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
      state.fetchPresetups(),
      state.fetchStats()
    ])
  },

  openApplication: async (workflowId: string) => {
    const { openTabs } = get()

    // If already open, just switch to it
    const existing = openTabs.find((t) => t.workflowId === workflowId)
    if (existing) {
      set({ activeTabId: workflowId, expandedView: true })
      return
    }

    const app = get().applications.find((a) => a.workflowId === workflowId)
    const tenantId = app?.tenantId || useEnterpriseStore.getState().currentTenant?.id || ''

    // Create new tab in executing state
    const newTab: ApplicationTab = {
      workflowId,
      url: null,
      executing: true,
      polling: false,
      error: null,
      executionStatus: null
    }
    set({ openTabs: [...openTabs, newTab], activeTabId: workflowId, expandedView: true })

    try {
      await enterpriseApi.enableIframeAuth()

      const result = await enterpriseApi.apiRequest('POST', '/api/workflows/execute/ui', {
        workflowId,
        tenantId,
        input: {
          userId: 'current-user',
          metadata: 'application-execution',
          timestamp: new Date().toISOString()
        }
      }) as { executionId?: string }

      if (!result.executionId) {
        throw new Error('No execution ID returned from server')
      }

      set({ openTabs: updateTab(get().openTabs, workflowId, { executing: false, polling: true }) })

      // Poll execution until application URL is found
      const poll = async (execId: string) => {
        // Stop polling if tab was closed while we were waiting
        if (!get().openTabs.find((t) => t.workflowId === workflowId)) return

        try {
          const execution = await enterpriseApi.apiRequest(
            'GET',
            `/api/workflow-executions/${execId}`
          ) as ExecutionData

          set({ openTabs: updateTab(get().openTabs, workflowId, { executionStatus: execution.status }) })

          const url = findApplicationUrl(execution.steps)
          if (url) {
            set({ openTabs: updateTab(get().openTabs, workflowId, { url, polling: false }) })
            return
          }

          const status = execution.status.toLowerCase()
          if (status === 'running' || status === 'pending') {
            setTimeout(() => poll(execId), 2000)
          } else if (status === 'failed') {
            set({ openTabs: updateTab(get().openTabs, workflowId, { polling: false, error: 'Application execution failed' }) })
          } else {
            set({ openTabs: updateTab(get().openTabs, workflowId, { polling: false, error: 'No application URL found in execution output' }) })
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message.toLowerCase() : ''
          const isNotFound = msg.includes('404') || msg.includes('not found') || msg.includes('execution')
          if (isNotFound) {
            setTimeout(() => poll(execId), 3000)
            return
          }
          set({ openTabs: updateTab(get().openTabs, workflowId, { polling: false, error: 'Failed to check execution status' }) })
        }
      }

      poll(result.executionId)
    } catch (err) {
      console.error('Failed to open application:', err)
      set({
        openTabs: updateTab(get().openTabs, workflowId, {
          executing: false,
          polling: false,
          error: err instanceof Error ? err.message : 'Failed to execute application'
        })
      })
    }
  },

  switchTab: (workflowId: string) => {
    set({ activeTabId: workflowId })
  },

  closeTab: (workflowId: string) => {
    const { openTabs, activeTabId } = get()
    const remaining = openTabs.filter((t) => t.workflowId !== workflowId)
    const newActiveId = activeTabId === workflowId
      ? (remaining.length > 0 ? remaining[remaining.length - 1].workflowId : null)
      : activeTabId
    // Single set() call to avoid intermediate renders with inconsistent state
    if (remaining.length === 0) {
      set({ openTabs: remaining, activeTabId: newActiveId, expandedView: false })
      enterpriseApi.disableIframeAuth().catch(() => {})
    } else {
      set({ openTabs: remaining, activeTabId: newActiveId })
    }
  },

  minimizeToCards: () => {
    set({ expandedView: false })
  }
}))
