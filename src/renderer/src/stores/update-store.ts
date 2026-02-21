import { create } from 'zustand'
import { updaterApi, appApi, onUpdaterStatus } from '@/lib/ipc-client'
import type { UpdateStatusType } from '@/types/electron'

interface UpdateState {
  status: UpdateStatusType | 'idle'
  version: string | null
  releaseNotes: string | null
  progress: { percent: number; bytesPerSecond: number; transferred: number; total: number } | null
  error: string | null
  dismissed: boolean
  appVersion: string | null

  dismiss: () => void
  checkForUpdates: () => Promise<void>
  downloadUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
  initListener: () => () => void
  loadAppVersion: () => Promise<void>
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: 'idle',
  version: null,
  releaseNotes: null,
  progress: null,
  error: null,
  dismissed: false,
  appVersion: null,

  dismiss: () => set({ dismissed: true }),

  checkForUpdates: async () => {
    try {
      await updaterApi.check()
    } catch (err) {
      console.error('[UpdateStore] Check failed:', err)
    }
  },

  downloadUpdate: async () => {
    try {
      await updaterApi.download()
    } catch (err) {
      console.error('[UpdateStore] Download failed:', err)
    }
  },

  installUpdate: async () => {
    try {
      await updaterApi.install()
    } catch (err) {
      console.error('[UpdateStore] Install failed:', err)
    }
  },

  initListener: () => {
    const cleanup = onUpdaterStatus((event) => {
      const updates: Partial<UpdateState> = {
        status: event.status,
        error: event.error ?? null,
        progress: event.progress ?? null
      }

      if (event.version) {
        updates.version = event.version
      }
      if (event.releaseNotes !== undefined) {
        updates.releaseNotes = event.releaseNotes ?? null
      }

      // Reset dismissed when a new update is detected
      if (event.status === 'available') {
        const currentVersion = get().version
        if (currentVersion !== event.version) {
          updates.dismissed = false
        }
      }

      set(updates)
    })
    return cleanup
  },

  loadAppVersion: async () => {
    try {
      const version = await appApi.getVersion()
      set({ appVersion: version })
    } catch (err) {
      console.error('[UpdateStore] Failed to load app version:', err)
    }
  }
}))
