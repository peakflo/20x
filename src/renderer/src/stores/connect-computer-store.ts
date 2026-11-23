import { create } from 'zustand'

interface ConnectComputerState {
  open: boolean
  /** Reconnect: the machine whose agents move to the new connection. */
  replacesRunnerId: string | null
  replacesName: string | null
  openConnect: (options?: { replacesRunnerId?: string; replacesName?: string }) => void
  close: () => void
}

/**
 * Opens the "Connect this computer" modal from anywhere: Settings → Machines,
 * and the Run-on picker's "Manage machines…" (which calls `openConnect()`).
 */
export const useConnectComputerStore = create<ConnectComputerState>((set) => ({
  open: false,
  replacesRunnerId: null,
  replacesName: null,
  openConnect: (options) =>
    set({ open: true, replacesRunnerId: options?.replacesRunnerId ?? null, replacesName: options?.replacesName ?? null }),
  close: () => set({ open: false, replacesRunnerId: null, replacesName: null })
}))
