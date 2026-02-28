import { describe, it, expect, beforeEach } from 'vitest'
import { useUIStore } from './ui-store'
import { TaskStatus, SettingsTab } from '@/types'

describe('useUIStore', () => {
  beforeEach(() => {
    // Reset store state between tests
    useUIStore.setState({
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
      settingsTab: SettingsTab.GENERAL
    })
  })

  it('has correct initial state', () => {
    const state = useUIStore.getState()
    expect(state.sidebarView).toBe('tasks')
    expect(state.statusFilter).toBe('all')
    expect(state.priorityFilter).toBe('all')
    expect(state.sourceFilter).toBe('all')
    expect(state.sortField).toBe('created_at')
    expect(state.sortDirection).toBe('desc')
    expect(state.searchQuery).toBe('')
    expect(state.activeModal).toBeNull()
    expect(state.editingTaskId).toBeNull()
    expect(state.deletingTaskId).toBeNull()
  })

  it('setSidebarView changes the view', () => {
    useUIStore.getState().setSidebarView('skills')
    expect(useUIStore.getState().sidebarView).toBe('skills')
  })

  it('setStatusFilter updates filter', () => {
    useUIStore.getState().setStatusFilter(TaskStatus.Completed)
    expect(useUIStore.getState().statusFilter).toBe(TaskStatus.Completed)
  })

  it('setPriorityFilter updates filter', () => {
    useUIStore.getState().setPriorityFilter('high')
    expect(useUIStore.getState().priorityFilter).toBe('high')
  })

  it('setSourceFilter updates filter', () => {
    useUIStore.getState().setSourceFilter('source-123')
    expect(useUIStore.getState().sourceFilter).toBe('source-123')
  })

  it('setSortField updates sort field', () => {
    useUIStore.getState().setSortField('priority')
    expect(useUIStore.getState().sortField).toBe('priority')
  })

  it('setSortDirection updates direction', () => {
    useUIStore.getState().setSortDirection('asc')
    expect(useUIStore.getState().sortDirection).toBe('asc')
  })

  it('setSearchQuery updates query', () => {
    useUIStore.getState().setSearchQuery('bug fix')
    expect(useUIStore.getState().searchQuery).toBe('bug fix')
  })

  describe('modals', () => {
    it('openCreateModal sets modal and clears editingTaskId', () => {
      useUIStore.getState().openCreateModal()
      const state = useUIStore.getState()
      expect(state.activeModal).toBe('create')
      expect(state.editingTaskId).toBeNull()
    })

    it('openEditModal sets modal and editingTaskId', () => {
      useUIStore.getState().openEditModal('task-123')
      const state = useUIStore.getState()
      expect(state.activeModal).toBe('edit')
      expect(state.editingTaskId).toBe('task-123')
    })

    it('openDeleteModal sets modal and deletingTaskId', () => {
      useUIStore.getState().openDeleteModal('task-456')
      const state = useUIStore.getState()
      expect(state.activeModal).toBe('delete')
      expect(state.deletingTaskId).toBe('task-456')
    })

    it('openSettings sets modal', () => {
      useUIStore.getState().openSettings()
      expect(useUIStore.getState().activeModal).toBe('settings')
    })

    it('closeModal resets all modal state', () => {
      useUIStore.getState().openEditModal('task-123')
      useUIStore.getState().closeModal()
      const state = useUIStore.getState()
      expect(state.activeModal).toBeNull()
      expect(state.editingTaskId).toBeNull()
      expect(state.deletingTaskId).toBeNull()
    })
  })
})
