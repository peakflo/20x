import { autoUpdater } from 'electron-updater'
import { app, BrowserWindow } from 'electron'
import type { DatabaseManager } from './database'

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours

export interface UpdateInfo {
  version: string
  releaseNotes: string | null
  releaseDate: string
}

export interface UpdateDownloadProgress {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}

/**
 * Initialize the auto-updater and forward all events to the renderer via IPC.
 */
export function initUpdater(mainWindow: BrowserWindow): void {
  // Don't auto-download — let the user decide
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    if (mainWindow.isDestroyed()) return
    const payload: UpdateInfo = {
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : Array.isArray(info.releaseNotes)
          ? info.releaseNotes.map((n) => `## ${n.version}\n${n.note}`).join('\n\n')
          : null,
      releaseDate: info.releaseDate ?? ''
    }
    mainWindow.webContents.send('update:available', payload)
  })

  autoUpdater.on('update-not-available', () => {
    if (mainWindow.isDestroyed()) return
    mainWindow.webContents.send('update:not-available')
  })

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow.isDestroyed()) return
    const payload: UpdateDownloadProgress = {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    }
    mainWindow.webContents.send('update:download-progress', payload)
  })

  autoUpdater.on('update-downloaded', () => {
    if (mainWindow.isDestroyed()) return
    mainWindow.webContents.send('update:downloaded')
  })

  autoUpdater.on('error', (err) => {
    if (mainWindow.isDestroyed()) return
    mainWindow.webContents.send('update:error', err?.message ?? 'Unknown error')
  })
}

/**
 * Check for updates. Returns the result from electron-updater.
 */
export async function checkForUpdates(): Promise<void> {
  await autoUpdater.checkForUpdates()
}

/**
 * Download an available update.
 */
export async function downloadUpdate(): Promise<void> {
  await autoUpdater.downloadUpdate()
}

/**
 * Quit the app and install the downloaded update.
 */
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall()
}

/**
 * Get the current app version.
 */
export function getCurrentVersion(): string {
  return app.getVersion()
}

/**
 * Check whether enough time has passed since the last update check (24h).
 */
export function shouldCheckForUpdate(db: DatabaseManager): boolean {
  try {
    const lastCheck = db.getSetting('last_update_check')
    if (!lastCheck) return true
    const elapsed = Date.now() - parseInt(lastCheck, 10)
    return elapsed >= UPDATE_CHECK_INTERVAL_MS
  } catch {
    return true
  }
}

/**
 * Record the timestamp of the most recent update check.
 */
export function recordUpdateCheck(db: DatabaseManager): void {
  try {
    db.setSetting('last_update_check', Date.now().toString())
  } catch (err) {
    console.error('[Updater] Failed to record update check:', err)
  }
}
