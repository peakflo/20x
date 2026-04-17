import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { app, BrowserWindow, ipcMain } from 'electron'

let mainWin: BrowserWindow | null = null

/** Version of the latest available update (set when update-available fires) */
let pendingVersion: string | null = null

/** Whether an update has been downloaded and is ready to install */
let updateDownloaded = false

const ONE_DAY_MS = 24 * 60 * 60 * 1000

export function initAutoUpdater(win: BrowserWindow): void {
  mainWin = win

  // Silently download in the background so the update is ready when the user quits
  autoUpdater.autoDownload = true
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
    // Suppress 404 errors — no releases published yet is expected
    if (err.message?.includes('404') || err.message?.includes('Cannot find latest')) {
      return
    }
    send('updater:status', {
      status: 'error',
      error: err.message
    })
  })

  // IPC handlers
  ipcMain.handle('updater:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      return { success: true, version: result?.updateInfo?.version ?? null }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('updater:download', async () => {
    try {
      await autoUpdater.downloadUpdate()
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('updater:install', () => {
    autoUpdater.quitAndInstall()
  })

  ipcMain.handle('updater:getVersion', () => {
    return app.getVersion()
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
