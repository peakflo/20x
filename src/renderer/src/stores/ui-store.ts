import { create } from 'zustand'
import type { TaskStatus, TaskPriority } from '@/types'

export type SortField = 'created_at' | 'updated_at' | 'priority' | 'due_date' | 'title'
export type SortDirection = 'asc' | 'desc'
export type ActiveModal = 'create' | 'edit' | 'delete' | 'agent-settings' | 'repo-selector' | 'gh-setup' | null

interface UIState {
  statusFilter: TaskStatus | 'all'
  priorityFilter: TaskPriority | 'all'
  sortField: SortField
  sortDirection: SortDirection
  searchQuery: string
  activeModal: ActiveModal
  editingTaskId: string | null
  deletingTaskId: string | null

  setStatusFilter: (filter: TaskStatus | 'all') => void
  setPriorityFilter: (filter: TaskPriority | 'all') => void
  setSortField: (field: SortField) => void
  setSortDirection: (dir: SortDirection) => void
  setSearchQuery: (query: string) => void
  openCreateModal: () => void
  openEditModal: (taskId: string) => void
  openDeleteModal: (taskId: string) => void
  openAgentSettings: () => void
  closeModal: () => void
}

export const useUIStore = create<UIState>((set) => ({
  statusFilter: 'all',
  priorityFilter: 'all',
  sortField: 'created_at',
  sortDirection: 'desc',
  searchQuery: '',
  activeModal: null,
  editingTaskId: null,
  deletingTaskId: null,

  setStatusFilter: (statusFilter) => set({ statusFilter }),
  setPriorityFilter: (priorityFilter) => set({ priorityFilter }),
  setSortField: (sortField) => set({ sortField }),
  setSortDirection: (sortDirection) => set({ sortDirection }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),

  openCreateModal: () => set({ activeModal: 'create', editingTaskId: null }),
  openEditModal: (taskId) => set({ activeModal: 'edit', editingTaskId: taskId }),
  openDeleteModal: (taskId) => set({ activeModal: 'delete', deletingTaskId: taskId }),
  openAgentSettings: () => set({ activeModal: 'agent-settings' }),
  closeModal: () => set({ activeModal: null, editingTaskId: null, deletingTaskId: null })
}))
