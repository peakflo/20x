import { create } from 'zustand'
import type { AcpAgentInstanceView } from '@shared/acp-registry'
import { acpInstanceApi } from '@/lib/ipc-client'

interface AcpInstanceState {
  /** Configured ACP agent instances (registry installs or local commands). */
  instances: AcpAgentInstanceView[]
  loaded: boolean
  /** Reloads the list from the main process. Errors leave the previous list in place. */
  load: () => Promise<void>
}

export const useAcpInstanceStore = create<AcpInstanceState>((set) => ({
  instances: [],
  loaded: false,
  load: async () => {
    try {
      const instances = await acpInstanceApi.list()
      set({ instances, loaded: true })
    } catch (err) {
      console.warn('[acp-instance-store] Could not load ACP agent instances:', err)
      set({ loaded: true })
    }
  }
}))
