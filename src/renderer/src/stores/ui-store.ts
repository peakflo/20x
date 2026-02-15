import { create } from 'zustand'
import { TaskStatus, SettingsTab } from '@/types'
import type { TaskPriority } from '@/types'

export type SortField = 'created_at' | 'updated_at' | 'priority' | 'due_date' | 'title' | 'status'
export type SortDirection = 'asc' | 'desc'
export type ActiveModal = 'create' | 'edit' | 'delete' | 'settings' | 'repo-selector' | 'gh-setup' | null
export type SidebarView = 'tasks' | 'skills'

interface UIState {
  sidebarView: SidebarView
  statusFilter: TaskStatus | 'all'
  priorityFilter: TaskPriority | 'all'
  sourceFilter: string
  sortField: SortField
  sortDirection: SortDirection
  searchQuery: string
  activeModal: ActiveModal
  editingTaskId: string | null
  deletingTaskId: string | null
  settingsTab: SettingsTab

  setSidebarView: (view: SidebarView) => void
  setStatusFilter: (filter: TaskStatus | 'all') => void
  setPriorityFilter: (filter: TaskPriority | 'all') => void
  setSourceFilter: (filter: string) => void
  setSortField: (field: SortField) => void
  setSortDirection: (dir: SortDirection) => void
  setSearchQuery: (query: string) => void
  setSettingsTab: (tab: SettingsTab) => void
  openCreateModal: () => void
  openEditModal: (taskId: string) => void
  openDeleteModal: (taskId: string) => void
  openSettings: () => void
  closeModal: () => void
}

export const useUIStore = create<UIState>((set) => ({
  sidebarView: 'tasks',
  statusFilter: 'all',
  priorityFilter: 'all',
  sourceFilter: 'all',
  sortField: 'created_at',
  sortDirection: 'desc',
  searchQuery: '',
  activeModal: null,
  editingTaskId: null,
  deletingTaskId: null,
  settingsTab: SettingsTab.GENERAL,

  setSidebarView: (sidebarView) => set({ sidebarView }),
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  setPriorityFilter: (priorityFilter) => set({ priorityFilter }),
  setSourceFilter: (sourceFilter) => set({ sourceFilter }),
  setSortField: (sortField) => set({ sortField }),
  setSortDirection: (sortDirection) => set({ sortDirection }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSettingsTab: (settingsTab) => set({ settingsTab }),

  openCreateModal: () => set({ activeModal: 'create', editingTaskId: null }),
  openEditModal: (taskId) => set({ activeModal: 'edit', editingTaskId: taskId }),
  openDeleteModal: (taskId) => set({ activeModal: 'delete', deletingTaskId: taskId }),
  openSettings: () => set({ activeModal: 'settings' }),
  closeModal: () => set({ activeModal: null, editingTaskId: null, deletingTaskId: null })
}))
