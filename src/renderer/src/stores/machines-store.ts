import { create } from 'zustand'
import { enterpriseRunnersApi } from '@/lib/ipc-client'
import {
  buildUninstallPlan,
  machinesNeedingUpdate,
  type UninstallPlan,
  type MachinesFailure,
  type MachinesSnapshot
} from '@shared/enterprise-runners'

export type MachinesLoadState = 'idle' | 'loading' | 'ready' | 'error'

interface MachinesState {
  snapshot: MachinesSnapshot | null
  loadState: MachinesLoadState
  error: MachinesFailure | null
  /** Per-machine action in flight (rename/remove/update), for button states. */
  busyIds: string[]
  /** Last action error, shown inline. */
  actionError: string | null
  /** Set after Remove so the uninstall command can be shown. */
  removed: { name: string; uninstall: UninstallPlan } | null

  refresh: (options?: { quiet?: boolean }) => Promise<void>
  rename: (id: string, name: string) => Promise<boolean>
  remove: (id: string) => Promise<boolean>
  update: (id: string) => Promise<boolean>
  updateAll: () => Promise<void>
  dismissRemoved: () => void
  dismissActionError: () => void
}

const withBusy = (ids: string[], id: string): string[] => (ids.includes(id) ? ids : [...ids, id])
const withoutBusy = (ids: string[], id: string): string[] => ids.filter((x) => x !== id)

export const useMachinesStore = create<MachinesState>((set, get) => ({
  snapshot: null,
  loadState: 'idle',
  error: null,
  busyIds: [],
  actionError: null,
  removed: null,

  refresh: async ({ quiet = false } = {}) => {
    // Only show the loading state on the first load; polling stays silent.
    if (!quiet || get().snapshot === null) set({ loadState: 'loading' })
    try {
      const result = await enterpriseRunnersApi.list()
      if (result.ok) set({ snapshot: result.snapshot, loadState: 'ready', error: null })
      else set({ snapshot: null, loadState: 'error', error: result.error })
    } catch (error) {
      set({
        loadState: 'error',
        error: { kind: 'unavailable', message: error instanceof Error ? error.message : String(error) }
      })
    }
  },

  rename: async (id, name) => {
    set((s) => ({ busyIds: withBusy(s.busyIds, id), actionError: null }))
    try {
      const result = await enterpriseRunnersApi.rename(id, name)
      if (!result.ok) set({ actionError: result.error.message })
      else await get().refresh({ quiet: true })
      return result.ok
    } finally {
      set((s) => ({ busyIds: withoutBusy(s.busyIds, id) }))
    }
  },

  remove: async (id) => {
    const machine = get().snapshot?.machines.find((m) => m.id === id)
    set((s) => ({ busyIds: withBusy(s.busyIds, id), actionError: null }))
    try {
      const result = await enterpriseRunnersApi.remove(id)
      if (!result.ok) {
        set({ actionError: result.error.message })
        return false
      }
      set({ removed: { name: machine?.name ?? 'Machine', uninstall: result.uninstall ?? buildUninstallPlan({ version: null, runnerId: id, instances: machine?.serviceInstances ?? [] }) } })
      await get().refresh({ quiet: true })
      return true
    } finally {
      set((s) => ({ busyIds: withoutBusy(s.busyIds, id) }))
    }
  },

  update: async (id) => {
    set((s) => ({ busyIds: withBusy(s.busyIds, id), actionError: null }))
    try {
      const result = await enterpriseRunnersApi.update(id)
      if (!result.ok) set({ actionError: result.error.message })
      else await get().refresh({ quiet: true })
      return result.ok
    } finally {
      set((s) => ({ busyIds: withoutBusy(s.busyIds, id) }))
    }
  },

  updateAll: async () => {
    const targets = machinesNeedingUpdate(get().snapshot?.machines ?? [])
    for (const machine of targets) await get().update(machine.id)
  },

  dismissRemoved: () => set({ removed: null }),
  dismissActionError: () => set({ actionError: null })
}))
