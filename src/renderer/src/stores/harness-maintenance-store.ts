import { create } from 'zustand'
import type { HarnessKey, HarnessMaintenanceStatus, HarnessUpdateRunState } from '@shared/harness-maintenance'
import { harnessMaintenanceApi } from '@/lib/ipc-client'

/** One harness's live update progress/result, kept client-side between runs. */
export interface HarnessUpdateUiState {
  running: boolean
  progress: string
  run?: HarnessUpdateRunState
}

interface HarnessMaintenanceState {
  statuses: HarnessMaintenanceStatus[]
  loaded: boolean
  refreshing: boolean
  error: string | null
  updates: Record<string, HarnessUpdateUiState>

  /** Loads statuses and subscribes to live updates. Returns an unsubscribe function. */
  init: () => () => void
  /** Re-checks every harness. `fresh` bypasses the npm/Homebrew cache. */
  refresh: (fresh?: boolean) => Promise<void>
  /** Runs a single harness update. Always user-triggered. */
  update: (harness: HarnessKey) => Promise<void>
  /** Runs "Update all" — every harness with `canUpdate`. */
  updateAll: () => Promise<void>
  /** Applies a pushed status snapshot (exported for tests). */
  upsertMany: (statuses: HarnessMaintenanceStatus[]) => void
}

function upsertStatuses(current: HarnessMaintenanceStatus[], incoming: HarnessMaintenanceStatus[]): HarnessMaintenanceStatus[] {
  const byHarness = new Map(current.map((s) => [s.harness, s]))
  for (const status of incoming) byHarness.set(status.harness, status)
  return [...byHarness.values()]
}

let subscribers = 0
let unsubscribeUpdated: (() => void) | null = null
let unsubscribeProgress: (() => void) | null = null

export const useHarnessMaintenanceStore = create<HarnessMaintenanceState>((set, get) => ({
  statuses: [],
  loaded: false,
  refreshing: false,
  error: null,
  updates: {},

  init: () => {
    subscribers++
    if (subscribers === 1) {
      try {
        unsubscribeUpdated = harnessMaintenanceApi.onUpdated((statuses) => get().upsertMany(statuses))
        unsubscribeProgress = harnessMaintenanceApi.onProgress(({ harness, chunk }) => {
          set((state) => ({
            updates: {
              ...state.updates,
              [harness]: { running: true, progress: ((state.updates[harness]?.progress ?? '') + chunk).slice(-4000) }
            }
          }))
        })
      } catch (err) {
        console.warn('[harness-maintenance-store] Live update events unavailable:', err)
      }
      void (async () => {
        try {
          const statuses = await harnessMaintenanceApi.get()
          set({ statuses, loaded: true })
        } catch (err) {
          set({ loaded: true, error: err instanceof Error ? err.message : String(err) })
        }
      })()
    }
    return () => {
      subscribers = Math.max(0, subscribers - 1)
      if (subscribers === 0) {
        unsubscribeUpdated?.()
        unsubscribeProgress?.()
        unsubscribeUpdated = null
        unsubscribeProgress = null
      }
    }
  },

  refresh: async (fresh = false) => {
    set({ refreshing: true, error: null })
    try {
      const statuses = await harnessMaintenanceApi.refresh(fresh)
      set({ statuses })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      set({ refreshing: false })
    }
  },

  update: async (harness) => {
    set((state) => ({ updates: { ...state.updates, [harness]: { running: true, progress: '' } } }))
    try {
      const result = await harnessMaintenanceApi.update(harness)
      set((state) => ({
        updates: { ...state.updates, [harness]: { running: false, progress: state.updates[harness]?.progress ?? '', run: result.run } },
        statuses: upsertStatuses(state.statuses, [result.newStatus])
      }))
    } catch (err) {
      set((state) => ({
        updates: {
          ...state.updates,
          [harness]: {
            running: false,
            progress: state.updates[harness]?.progress ?? '',
            run: { harness, status: 'failed', message: err instanceof Error ? err.message : String(err), startedAt: new Date().toISOString() }
          }
        }
      }))
    }
  },

  updateAll: async () => {
    const canUpdate = get().statuses.filter((s) => s.canUpdate).map((s) => s.harness)
    set((state) => ({
      updates: canUpdate.reduce((acc, h) => ({ ...acc, [h]: { running: true, progress: '' } }), { ...state.updates })
    }))
    try {
      const result = await harnessMaintenanceApi.updateAll()
      set((state) => {
        const updates = { ...state.updates }
        for (const r of result.results) {
          updates[r.harness] = { running: false, progress: updates[r.harness]?.progress ?? '', run: r.run }
        }
        return { updates, statuses: upsertStatuses(state.statuses, result.results.map((r) => r.newStatus)) }
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  upsertMany: (statuses) => {
    set((state) => ({ statuses: upsertStatuses(state.statuses, statuses) }))
  }
}))
