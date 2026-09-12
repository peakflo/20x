import { create } from 'zustand'
import type { TaskGroupAction, TaskGroupResult, TaskGroupsSnapshot } from '@shared/task-groups'

interface GroupState extends TaskGroupsSnapshot {
  isLoaded: boolean
  view: string
  creationGroupId: string | null | undefined
  canvasGroupId: string | null
  error: string | null
  fetch: () => Promise<void>
  manage: (action: TaskGroupAction) => Promise<TaskGroupResult>
  setView: (view: string) => void
  setCreationGroup: (id: string | null | undefined) => void
  showOnCanvas: (id: string) => void
}

let request = 0

export const useTaskGroupStore = create<GroupState>((set, get) => ({
  isLoaded: false, groups: [], membership: {}, executions: {}, view: 'groups', creationGroupId: undefined, canvasGroupId: null, error: null,
  fetch: async () => {
    const current = ++request
    try {
      if (!window.electronAPI?.taskGroups) return
      const snapshot = await window.electronAPI.taskGroups.snapshot()
      if (current === request) {
        const view = get().view
        set({ ...snapshot, isLoaded: true, error: null, view: ['groups', 'all', 'ungrouped'].includes(view) || snapshot.groups.some(g => g.id === view) ? view : 'groups' })
      }
    } catch (error) { if (current === request) set({ error: String(error) }) }
  },
  manage: async action => {
    try {
      const result = await window.electronAPI.taskGroups.manage(action)
      await get().fetch()
      set({ error: result.error ?? null })
      return result
    } catch (error) {
      set({ error: String(error) })
      return { success: false, error: String(error) }
    }
  },
  setView: view => set({ view }),
  setCreationGroup: creationGroupId => set({ creationGroupId }),
  showOnCanvas: canvasGroupId => set({ canvasGroupId })
}))
