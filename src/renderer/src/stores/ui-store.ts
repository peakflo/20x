import { create } from 'zustand'
import { TaskStatus, SettingsTab } from '@/types'
import type { TaskPriority } from '@/types'

export type SortField = 'created_at' | 'updated_at' | 'priority' | 'due_date' | 'title' | 'status'
export type SortDirection = 'asc' | 'desc'
export type ActiveModal = 'create' | 'edit' | 'delete' | 'settings' | 'repo-selector' | 'gh-setup' | null
export type SidebarView = 'tasks' | 'skills' | 'dashboard' | 'canvas'
export type ThemeMode = 'light' | 'dark' | 'system'

/** Resolve the effective theme (light or dark) from the ThemeMode preference */
function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return mode
}

/** Apply the data-theme attribute to the document root */
function applyThemeToDOM(mode: ThemeMode): void {
  const resolved = resolveTheme(mode)
  document.documentElement.setAttribute('data-theme', resolved)
}

interface UIState {
  sidebarView: SidebarView
  statusFilter: TaskStatus | 'all'
  priorityFilter: TaskPriority | 'all'
  sourceFilter: string
  sortField: SortField
  sortDirection: SortDirection
  searchQuery: string
  skillSearchQuery: string
  activeModal: ActiveModal
  editingTaskId: string | null
  deletingTaskId: string | null
  settingsTab: SettingsTab
  dashboardPreviewTaskId: string | null
  /** Task ID to add to canvas when switching to canvas view */
  canvasPendingTaskId: string | null
  /** App to add to canvas when switching to canvas view */
  canvasPendingApp: { workflowId: string; name: string } | null
  /** Theme mode preference: light, dark, or system (auto) */
  theme: ThemeMode

  setSidebarView: (view: SidebarView) => void
  setStatusFilter: (filter: TaskStatus | 'all') => void
  setPriorityFilter: (filter: TaskPriority | 'all') => void
  setSourceFilter: (filter: string) => void
  setSortField: (field: SortField) => void
  setSortDirection: (dir: SortDirection) => void
  setSearchQuery: (query: string) => void
  setSkillSearchQuery: (query: string) => void
  setSettingsTab: (tab: SettingsTab) => void
  setTheme: (mode: ThemeMode) => void
  openCreateModal: () => void
  openEditModal: (taskId: string) => void
  openDeleteModal: (taskId: string) => void
  openSettings: () => void
  closeModal: () => void
  openDashboardPreview: (taskId: string) => void
  closeDashboardPreview: () => void
  /** Switch to canvas view and queue a task to be added as a panel */
  openTaskOnCanvas: (taskId: string) => void
  clearCanvasPendingTask: () => void
  /** Switch to canvas view and queue an app to be added as a panel */
  openAppOnCanvas: (workflowId: string, name: string) => void
  clearCanvasPendingApp: () => void
}

export const useUIStore = create<UIState>((set) => ({
  sidebarView: 'dashboard',
  statusFilter: 'all',
  priorityFilter: 'all',
  sourceFilter: 'all',
  sortField: 'created_at',
  sortDirection: 'desc',
  searchQuery: '',
  skillSearchQuery: '',
  activeModal: null,
  editingTaskId: null,
  deletingTaskId: null,
  settingsTab: SettingsTab.GENERAL,
  dashboardPreviewTaskId: null,
  canvasPendingTaskId: null,
  canvasPendingApp: null,
  theme: (localStorage.getItem('20x-theme') as ThemeMode) || 'dark',

  setSidebarView: (sidebarView) => set({ sidebarView }),
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  setPriorityFilter: (priorityFilter) => set({ priorityFilter }),
  setSourceFilter: (sourceFilter) => set({ sourceFilter }),
  setSortField: (sortField) => {
    // Auto-set the most intuitive sort direction for each field
    const FIELD_DEFAULT_DIRECTION: Record<SortField, SortDirection> = {
      priority: 'desc',     // critical first
      status: 'desc',       // active/working first
      created_at: 'desc',   // newest first
      updated_at: 'desc',   // recently updated first
      due_date: 'asc',      // soonest deadline first
      title: 'asc'          // A-Z
    }
    set({ sortField, sortDirection: FIELD_DEFAULT_DIRECTION[sortField] })
  },
  setSortDirection: (sortDirection) => set({ sortDirection }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSkillSearchQuery: (skillSearchQuery) => set({ skillSearchQuery }),
  setSettingsTab: (settingsTab) => set({ settingsTab }),
  setTheme: (theme) => {
    localStorage.setItem('20x-theme', theme)
    applyThemeToDOM(theme)
    // Sync native window chrome (titlebar, background color) with the theme
    const resolved = resolveTheme(theme)
    window.electronAPI?.app?.setTheme?.(resolved)
    set({ theme })
  },

  openCreateModal: () => set({ activeModal: 'create', editingTaskId: null }),
  openEditModal: (taskId) => set({ activeModal: 'edit', editingTaskId: taskId }),
  openDeleteModal: (taskId) => set({ activeModal: 'delete', deletingTaskId: taskId }),
  openSettings: () => set({ activeModal: 'settings' }),
  closeModal: () => set({ activeModal: null, editingTaskId: null, deletingTaskId: null }),
  openDashboardPreview: (taskId) => set({ dashboardPreviewTaskId: taskId }),
  closeDashboardPreview: () => set({ dashboardPreviewTaskId: null }),
  openTaskOnCanvas: (taskId) => set({ sidebarView: 'canvas', canvasPendingTaskId: taskId, dashboardPreviewTaskId: null }),
  clearCanvasPendingTask: () => set({ canvasPendingTaskId: null }),
  openAppOnCanvas: (workflowId, name) => set({ sidebarView: 'canvas', canvasPendingApp: { workflowId, name }, dashboardPreviewTaskId: null }),
  clearCanvasPendingApp: () => set({ canvasPendingApp: null })
}))

// ── Initialize theme on load ───────────────────────────────
const initialTheme = useUIStore.getState().theme
applyThemeToDOM(initialTheme)

// Listen for system theme changes when in 'system' mode
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const { theme } = useUIStore.getState()
  if (theme === 'system') {
    applyThemeToDOM('system')
  }
})
