import { create } from 'zustand'
import type { HarnessInstanceView } from '@shared/harness-instances'
import { harnessInstanceApi } from '@/lib/ipc-client'

interface HarnessInstanceState {
  /** Stored harness instances (subscription logins). The implicit defaults are not listed. */
  instances: HarnessInstanceView[]
  loaded: boolean
  /** Reloads the list from the main process. Errors leave the previous list in place. */
  load: () => Promise<void>
}

export const useHarnessInstanceStore = create<HarnessInstanceState>((set) => ({
  instances: [],
  loaded: false,
  load: async () => {
    try {
      const instances = await harnessInstanceApi.list()
      set({ instances, loaded: true })
    } catch (err) {
      console.warn('[harness-instance-store] Could not load harness instances:', err)
      set({ loaded: true })
    }
  }
}))
