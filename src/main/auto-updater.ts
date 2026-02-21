import { autoUpdater } from 'electron-updater'
import { app, BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'

let mainWindow: BrowserWindow | null = null
let checkInterval: ReturnType<typeof setInterval> | null = null

export type UpdateStatusType =
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateStatus {
  status: UpdateStatusType
  version?: string
  releaseNotes?: string
  progress?: { percent: number; bytesPerSecond: number; transferred: number; total: number }
  error?: string
}

function sendStatus(status: UpdateStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:status', status)
  }
}

export function initAutoUpdater(win: BrowserWindow): void {
  if (is.dev) {
    console.log('[AutoUpdater] Skipping in dev mode')
    return
  }

  mainWindow = win

  // Configuration
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  // Forward events to renderer
  autoUpdater.on('checking-for-update', () => {
    console.log('[AutoUpdater] Checking for update...')
    sendStatus({ status: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    console.log('[AutoUpdater] Update available:', info.version)
    const releaseNotes =
      typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : Array.isArray(info.releaseNotes)
          ? info.releaseNotes.map((n) => n.note).join('\n')
          : undefined
    sendStatus({
      status: 'available',
      version: info.version,
      releaseNotes
    })
  })

  autoUpdater.on('update-not-available', (info) => {
    console.log('[AutoUpdater] No update available. Current:', info.version)
    sendStatus({ status: 'not-available', version: info.version })
  })

  autoUpdater.on('download-progress', (progress) => {
    console.log(`[AutoUpdater] Download progress: ${progress.percent.toFixed(1)}%`)
    sendStatus({
      status: 'downloading',
      progress: {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total
      }
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[AutoUpdater] Update downloaded:', info.version)
    sendStatus({ status: 'downloaded', version: info.version })
  })

  autoUpdater.on('error', (err) => {
    console.error('[AutoUpdater] Error:', err.message)
    sendStatus({ status: 'error', error: err.message })
  })

  // Initial check after 5 seconds
  setTimeout(() => {
    checkForUpdates()
  }, 5_000)

  // Periodic check every 4 hours
  checkInterval = setInterval(
    () => {
      checkForUpdates()
    },
    4 * 60 * 60 * 1_000
  )

  // Cleanup interval when window is destroyed
  win.on('closed', () => {
    if (checkInterval) {
      clearInterval(checkInterval)
      checkInterval = null
    }
    mainWindow = null
  })
}

export async function checkForUpdates(): Promise<void> {
  if (is.dev) return
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    console.error('[AutoUpdater] Check failed:', err)
  }
}

export async function downloadUpdate(): Promise<void> {
  if (is.dev) return
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    console.error('[AutoUpdater] Download failed:', err)
  }
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall(false, true)
}

export function getAppVersion(): string {
  return app.getVersion()
}
