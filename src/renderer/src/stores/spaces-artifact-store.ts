import { create } from 'zustand'
import type { SpacesArtifactsResult } from '@shared/enterprise-runners'
import { enterpriseRunnersApi } from '@/lib/ipc-client'

interface SpacesArtifactState {
  byTask: Record<string, SpacesArtifactsResult>
  load: (taskId: string, refresh?: boolean) => Promise<void>
}

const LOADING: SpacesArtifactsResult = { status: 'loading', artifacts: [], syncedAt: null }

export const useSpacesArtifactStore = create<SpacesArtifactState>((set, get) => ({
  byTask: {},
  load: async (taskId, refresh = false) => {
    const prev = get().byTask[taskId]
    // Keep showing the previous rows while a refresh is in flight.
    set((s) => ({ byTask: { ...s.byTask, [taskId]: prev && prev.status !== 'loading' ? { ...prev, status: 'loading' } : LOADING } }))
    try {
      const result = await enterpriseRunnersApi.listSpacesArtifacts(taskId, { refresh })
      set((s) => ({ byTask: { ...s.byTask, [taskId]: result } }))
    } catch (error) {
      set((s) => ({
        byTask: { ...s.byTask, [taskId]: { status: 'error', artifacts: prev?.artifacts ?? [], syncedAt: prev?.syncedAt ?? null, error: error instanceof Error ? error.message : String(error) } }
      }))
    }
  }
}))
