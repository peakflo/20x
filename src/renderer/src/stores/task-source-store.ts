import { create } from 'zustand'
import type { TaskSource, CreateTaskSourceDTO, UpdateTaskSourceDTO, SyncResult, ActionResult } from '@/types'
import { taskSourceApi, pluginApi } from '@/lib/ipc-client'

interface TaskSourceState {
  sources: TaskSource[]
  isLoading: boolean
  error: string | null
  syncingIds: Set<string>
  lastSyncResults: Map<string, SyncResult>

  fetchSources: () => Promise<void>
  createSource: (data: CreateTaskSourceDTO) => Promise<TaskSource | null>
  updateSource: (id: string, data: UpdateTaskSourceDTO) => Promise<TaskSource | null>
  deleteSource: (id: string) => Promise<boolean>
  syncSource: (sourceId: string) => Promise<SyncResult | null>
  syncAllEnabled: () => Promise<void>
  executeAction: (actionId: string, taskId: string, sourceId: string, input?: string) => Promise<ActionResult>
}

export const useTaskSourceStore = create<TaskSourceState>((set, get) => ({
  sources: [],
  isLoading: false,
  error: null,
  syncingIds: new Set(),
  lastSyncResults: new Map(),

  fetchSources: async () => {
    set({ isLoading: true, error: null })
    try {
      const sources = await taskSourceApi.getAll()
      set({ sources, isLoading: false })
    } catch (err) {
      set({ error: String(err), isLoading: false })
    }
  },

  createSource: async (data) => {
    try {
      const source = await taskSourceApi.create(data)
      set((state) => ({ sources: [...state.sources, source] }))
      return source
    } catch (err) {
      set({ error: String(err) })
      return null
    }
  },

  updateSource: async (id, data) => {
    try {
      const updated = await taskSourceApi.update(id, data)
      if (updated) {
        set((state) => ({
          sources: state.sources.map((s) => (s.id === id ? updated : s))
        }))
      }
      return updated || null
    } catch (err) {
      set({ error: String(err) })
      return null
    }
  },

  deleteSource: async (id) => {
    try {
      const success = await taskSourceApi.delete(id)
      if (success) {
        set((state) => ({
          sources: state.sources.filter((s) => s.id !== id)
        }))
      }
      return success
    } catch (err) {
      set({ error: String(err) })
      return false
    }
  },

  syncSource: async (sourceId) => {
    set((state) => {
      const next = new Set(state.syncingIds)
      next.add(sourceId)
      return { syncingIds: next }
    })

    try {
      const result = await taskSourceApi.sync(sourceId)
      set((state) => {
        const next = new Set(state.syncingIds)
        next.delete(sourceId)
        const results = new Map(state.lastSyncResults)
        results.set(sourceId, result)
        const sources = state.sources.map((s) =>
          s.id === sourceId ? { ...s, last_synced_at: new Date().toISOString() } : s
        )
        return { syncingIds: next, lastSyncResults: results, sources }
      })
      return result
    } catch (err) {
      set((state) => {
        const next = new Set(state.syncingIds)
        next.delete(sourceId)
        return { syncingIds: next, error: String(err) }
      })
      return null
    }
  },

  syncAllEnabled: async () => {
    const { sources, syncSource } = get()
    const enabled = sources.filter((s) => s.enabled)
    await Promise.allSettled(enabled.map((s) => syncSource(s.id)))
  },

  executeAction: async (actionId, taskId, sourceId, input) => {
    try {
      return await pluginApi.executeAction(actionId, taskId, sourceId, input)
    } catch (err) {
      return { success: false, error: String(err) }
    }
  }
}))
