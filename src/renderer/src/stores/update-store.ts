import { create } from 'zustand'
import { updateApi, onUpdateAvailable, onUpdateNotAvailable, onUpdateDownloadProgress, onUpdateDownloaded, onUpdateError } from '@/lib/ipc-client'
import type { UpdateInfo, UpdateDownloadProgress } from '@/types/electron'

interface UpdateState {
  /** Info about the available update, or null if none */
  updateAvailable: UpdateInfo | null
  /** Whether a check is currently in progress */
  isChecking: boolean
  /** Whether the update is being downloaded */
  isDownloading: boolean
  /** Download progress (0-100) */
  downloadProgress: UpdateDownloadProgress | null
  /** Whether the update has been downloaded and is ready to install */
  isReadyToInstall: boolean
  /** Current app version */
  currentVersion: string | null
  /** Error message from the last operation */
  error: string | null

  /** Trigger a manual update check */
  checkForUpdates: () => Promise<void>
  /** Start downloading the available update */
  downloadUpdate: () => Promise<void>
  /** Quit the app and install the downloaded update */
  installUpdate: () => Promise<void>
  /** Load the current app version */
  loadVersion: () => Promise<void>
  /** Clear the update-available state */
  dismissUpdate: () => void
  /** Subscribe to all update events from the main process; returns cleanup fn */
  initListeners: () => () => void
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  updateAvailable: null,
  isChecking: false,
  isDownloading: false,
  downloadProgress: null,
  isReadyToInstall: false,
  currentVersion: null,
  error: null,

  checkForUpdates: async () => {
    set({ isChecking: true, error: null })
    try {
      await updateApi.check()
      // The result comes asynchronously via the 'update:available' or 'update:not-available' event.
      // We clear isChecking in the event handlers below.
    } catch (err) {
      set({ isChecking: false, error: err instanceof Error ? err.message : 'Check failed' })
    }
  },

  downloadUpdate: async () => {
    set({ isDownloading: true, downloadProgress: null, error: null })
    try {
      await updateApi.download()
    } catch (err) {
      set({ isDownloading: false, error: err instanceof Error ? err.message : 'Download failed' })
    }
  },

  installUpdate: async () => {
    await updateApi.install()
  },

  loadVersion: async () => {
    try {
      const version = await updateApi.getVersion()
      set({ currentVersion: version })
    } catch {
      // Ignore — version display is non-critical
    }
  },

  dismissUpdate: () => {
    set({ updateAvailable: null, isReadyToInstall: false, downloadProgress: null, isDownloading: false })
  },

  initListeners: () => {
    const cleanups = [
      onUpdateAvailable((info) => {
        set({
          updateAvailable: { ...info, releaseNotes: info.releaseNotes ?? null },
          isChecking: false,
          error: null
        })
      }),
      onUpdateNotAvailable(() => {
        set({ isChecking: false })
      }),
      onUpdateDownloadProgress((progress) => {
        set({ downloadProgress: progress })
      }),
      onUpdateDownloaded(() => {
        set({ isDownloading: false, isReadyToInstall: true, downloadProgress: null })
      }),
      onUpdateError((message) => {
        const state = get()
        set({
          isChecking: false,
          isDownloading: false,
          error: state.isChecking || state.isDownloading ? message : null
        })
      })
    ]

    return () => {
      cleanups.forEach((cleanup) => cleanup())
    }
  }
}))
