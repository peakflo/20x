import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { BrowserWindow, ipcMain } from 'electron'

let mainWin: BrowserWindow | null = null

export function initAutoUpdater(win: BrowserWindow): void {
  mainWin = win

  // Don't auto-download — let the user decide
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    send('updater:status', { status: 'checking' })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    send('updater:status', {
      status: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : ''
    })
  })

  autoUpdater.on('update-not-available', () => {
    send('updater:status', { status: 'up-to-date' })
  })

  autoUpdater.on('download-progress', (progress) => {
    send('updater:status', {
      status: 'downloading',
      percent: Math.round(progress.percent)
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
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

  // Check for updates on startup (after a short delay)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {
      // Silently ignore — no releases published yet is fine
    })
  }, 10_000)
}

function send(channel: string, data: unknown): void {
  mainWin?.webContents?.send(channel, data)
}
