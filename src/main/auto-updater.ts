import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { app, BrowserWindow, ipcMain } from 'electron'

let mainWin: BrowserWindow | null = null
let updaterActive = false

/** Version of the latest available update (set when update-available fires) */
let pendingVersion: string | null = null

/** Whether an update has been downloaded and is ready to install */
let updateDownloaded = false

const ONE_DAY_MS = 24 * 60 * 60 * 1000

/**
 * Register updater IPC handlers. Must be called early (before the renderer
 * loads) so that `ipcRenderer.invoke('updater:*')` never throws
 * "No handler registered". Safe to call in dev mode — the handlers simply
 * return no-op results when the real updater hasn't been started.
 */
export function registerUpdaterIpc(): void {
  ipcMain.handle('updater:check', async () => {
    if (!updaterActive) return { success: false, error: 'Updater not available in dev mode' }
    try {
      const result = await autoUpdater.checkForUpdates()
      return { success: true, version: result?.updateInfo?.version ?? null }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('updater:download', async () => {
    if (!updaterActive) return { success: false, error: 'Updater not available in dev mode' }
    try {
      await autoUpdater.downloadUpdate()
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('updater:install', () => {
    if (!updaterActive) return
    autoUpdater.quitAndInstall()
  })

  ipcMain.handle('updater:getVersion', () => {
    return app.getVersion()
  })
}

/**
 * Start the real auto-updater (production only).
 * Call registerUpdaterIpc() first so the IPC handlers exist.
 */
export function initAutoUpdater(win: BrowserWindow): void {
  mainWin = win
  updaterActive = true

  // Don't auto-download — just detect updates. The user triggers the download
  // from the UpdateDialog. This avoids repeated ~170 MB downloads on every
  // app launch that can fail with ERR_CONNECTION_CLOSED on flaky connections.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false // We handle quit-time prompt ourselves

  autoUpdater.on('checking-for-update', () => {
    send('updater:status', { status: 'checking' })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    pendingVersion = info.version
    send('updater:status', {
      status: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : Array.isArray(info.releaseNotes)
          ? info.releaseNotes.map((n) => `## ${n.version}\n${n.note}`).join('\n\n')
          : '',
      releaseDate: info.releaseDate ?? '',
      currentVersion: app.getVersion()
    })
  })

  autoUpdater.on('update-not-available', () => {
    send('updater:status', { status: 'up-to-date', currentVersion: app.getVersion() })
  })

  autoUpdater.on('download-progress', (progress) => {
    send('updater:status', {
      status: 'downloading',
      percent: Math.round(progress.percent)
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    updateDownloaded = true
    send('updater:status', {
      status: 'downloaded',
      version: info.version
    })
  })

  autoUpdater.on('error', (err) => {
    // 404 / no releases published yet → treat as up-to-date so the UI resolves
    if (err.message?.includes('404') || err.message?.includes('Cannot find latest')) {
      send('updater:status', { status: 'up-to-date', currentVersion: app.getVersion() })
      return
    }
    // Network errors → user-friendly message; silently ignore from background checks
    const isNetworkError = err.message?.includes('ERR_CONNECTION') ||
      err.message?.includes('ENOTFOUND') ||
      err.message?.includes('ETIMEDOUT') ||
      err.message?.includes('ECONNREFUSED') ||
      err.message?.includes('net::')
    if (isNetworkError) {
      send('updater:status', {
        status: 'error',
        error: 'Could not check for updates. Please check your internet connection and try again.'
      })
      return
    }
    send('updater:status', {
      status: 'error',
      error: err.message
    })
  })

  // Check for updates on startup (after a short delay)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {
      // Silently ignore — no releases published yet is fine
    })
  }, 10_000)

  // Re-check once a day (24h interval)
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {})
  }, ONE_DAY_MS)
}

/**
 * Whether a downloaded update is ready to install.
 * Used by the quit-time prompt in index.ts.
 */
export function isUpdateDownloaded(): boolean {
  return updateDownloaded
}

/**
 * Get the pending update version (if any).
 */
export function getPendingVersion(): string | null {
  return pendingVersion
}

function send(channel: string, data: unknown): void {
  mainWin?.webContents?.send(channel, data)
}
