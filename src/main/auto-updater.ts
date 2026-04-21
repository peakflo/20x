import { autoUpdater, type Logger, type UpdateCheckResult, type UpdateInfo } from 'electron-updater'
import { app, BrowserWindow, ipcMain } from 'electron'
import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

let mainWin: BrowserWindow | null = null
let updaterActive = false

/** Version of the latest available update (set when update-available fires) */
let pendingVersion: string | null = null

/** Whether an update has been downloaded and is ready to install */
let updateDownloaded = false

/** Whether a user-initiated update download is currently running */
let updateDownloading = false

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const WINDOWS_SETUP_FILE_RE = /^20x-Setup-(\d+\.\d+\.\d+(?:[-+][^/\\]+)?)\.exe(\.blockmap)?$/i
let lastProgressLogAt = 0
let lastProgressPercent = -1

/**
 * Register updater IPC handlers. Must be called early (before the renderer
 * loads) so that `ipcRenderer.invoke('updater:*')` never throws
 * "No handler registered". Safe to call in dev mode — the handlers simply
 * return no-op results when the real updater hasn't been started.
 */
export function registerUpdaterIpc(): void {
  ipcMain.handle('updater:check', async () => {
    logUpdater('IPC updater:check invoked', {
      updaterActive,
      pendingVersion,
      updateDownloaded,
      updateDownloading
    })
    if (!updaterActive) return { success: false, error: 'Updater not available in dev mode' }
    try {
      const result = await autoUpdater.checkForUpdates()
      normalizeWindowsUpdateFileNames(result?.updateInfo)
      logUpdater('IPC updater:check completed', {
        isUpdateAvailable: result?.isUpdateAvailable,
        version: result?.updateInfo?.version
      })
      return { success: true, version: result?.updateInfo?.version ?? null }
    } catch (err) {
      logUpdater('IPC updater:check failed', err)
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('updater:download', async () => {
    logUpdater('IPC updater:download invoked', {
      updaterActive,
      pendingVersion,
      updateDownloaded,
      updateDownloading
    })
    if (!updaterActive) return { success: false, error: 'Updater not available in dev mode' }
    try {
      if (updateDownloaded) {
        logUpdater('Download skipped because update is already downloaded', { pendingVersion })
        return { success: true }
      }

      if (!pendingVersion) {
        logUpdater('No pending version before download; checking for updates first')
        const result = await autoUpdater.checkForUpdates()
        normalizeWindowsUpdateFileNames(result?.updateInfo)
        if (!isUpdateAvailable(result)) {
          logUpdater('Download aborted because check found no available update', {
            isUpdateAvailable: result?.isUpdateAvailable,
            version: result?.updateInfo?.version
          })
          return { success: false, error: 'No update is currently available' }
        }
      }

      updateDownloading = true
      lastProgressLogAt = 0
      lastProgressPercent = -1
      logUpdater('Starting update download', { pendingVersion })
      send('updater:status', { status: 'downloading', version: pendingVersion, percent: 0 })
      const downloadedFiles = await autoUpdater.downloadUpdate()
      logUpdater('autoUpdater.downloadUpdate resolved', { downloadedFiles })
      return { success: true }
    } catch (err) {
      logUpdater('IPC updater:download failed', err)
      return { success: false, error: (err as Error).message }
    } finally {
      updateDownloading = false
      logUpdater('IPC updater:download finished', {
        pendingVersion,
        updateDownloaded,
        updateDownloading
      })
    }
  })

  ipcMain.handle('updater:install', () => {
    logUpdater('IPC updater:install invoked', {
      updaterActive,
      pendingVersion,
      updateDownloaded
    })
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
  logUpdater('Auto updater initialized', {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    userData: app.getPath('userData')
  })

  // Don't auto-download — just detect updates. The user triggers the download
  // from the UpdateDialog. This avoids repeated ~170 MB downloads on every
  // app launch that can fail with ERR_CONNECTION_CLOSED on flaky connections.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false // We handle quit-time prompt ourselves
  autoUpdater.logger = createUpdaterLogger()

  autoUpdater.on('checking-for-update', () => {
    logUpdater('Event checking-for-update', {
      pendingVersion,
      updateDownloaded,
      updateDownloading
    })
    if (pendingVersion || updateDownloaded || updateDownloading) return
    send('updater:status', { status: 'checking' })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    normalizeWindowsUpdateFileNames(info)
    logUpdater('Event update-available', {
      version: info.version,
      releaseDate: info.releaseDate,
      files: info.files?.map((file) => ({
        url: file.url,
        size: file.size
      }))
    })
    pendingVersion = info.version
    updateDownloaded = false
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
    logUpdater('Event update-not-available', {
      pendingVersion,
      updateDownloaded,
      updateDownloading
    })
    if (hasPendingUpdate()) return
    send('updater:status', { status: 'up-to-date', currentVersion: app.getVersion() })
  })

  autoUpdater.on('download-progress', (progress) => {
    logDownloadProgress(progress)
    send('updater:status', {
      status: 'downloading',
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    logUpdater('Event update-downloaded', {
      version: info.version,
      releaseDate: info.releaseDate
    })
    updateDownloaded = true
    updateDownloading = false
    send('updater:status', {
      status: 'downloaded',
      version: info.version
    })
  })

  autoUpdater.on('error', (err) => {
    logUpdater('Event error', err)
    // 404 / no releases published yet → treat as up-to-date so the UI resolves
    if (err.message?.includes('404') || err.message?.includes('Cannot find latest')) {
      if (hasPendingUpdate()) return
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
    logUpdater('Startup update check scheduled now')
    autoUpdater.checkForUpdates().catch((err) => {
      logUpdater('Startup update check failed', err)
    })
  }, 10_000)

  // Re-check once a day (24h interval)
  setInterval(() => {
    logUpdater('Daily update check scheduled now')
    autoUpdater.checkForUpdates().catch((err) => {
      logUpdater('Daily update check failed', err)
    })
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

function isUpdateAvailable(result: UpdateCheckResult | null): boolean {
  return result?.isUpdateAvailable === true
}

function hasPendingUpdate(): boolean {
  return !!pendingVersion || updateDownloaded || updateDownloading
}

function normalizeWindowsUpdateFileNames(info: UpdateInfo | null | undefined): void {
  if (process.platform !== 'win32') return
  if (!info) return

  for (const file of info.files ?? []) {
    const normalizedUrl = normalizeWindowsSetupFileName(file.url)
    if (normalizedUrl !== file.url) {
      logUpdater('Normalized Windows update file URL', {
        from: file.url,
        to: normalizedUrl
      })
      file.url = normalizedUrl
    }
  }

  const mutableInfo = info as UpdateInfo & { path?: string }
  if (mutableInfo.path) {
    const normalizedPath = normalizeWindowsSetupFileName(mutableInfo.path)
    if (normalizedPath !== mutableInfo.path) {
      logUpdater('Normalized Windows update path', {
        from: mutableInfo.path,
        to: normalizedPath
      })
      mutableInfo.path = normalizedPath
    }
  }
}

function normalizeWindowsSetupFileName(fileName: string): string {
  const slashIndex = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'))
  const prefix = slashIndex >= 0 ? fileName.slice(0, slashIndex + 1) : ''
  const basename = slashIndex >= 0 ? fileName.slice(slashIndex + 1) : fileName
  const match = basename.match(WINDOWS_SETUP_FILE_RE)

  if (!match) return fileName
  return `${prefix}20x.Setup.${match[1]}.exe${match[2] ?? ''}`
}

function logDownloadProgress(progress: {
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
}): void {
  const now = Date.now()
  const percent = Math.round(progress.percent ?? 0)
  const shouldLog = percent !== lastProgressPercent || now - lastProgressLogAt > 5_000

  if (!shouldLog) return

  lastProgressLogAt = now
  lastProgressPercent = percent
  logUpdater('Event download-progress', {
    percent,
    rawPercent: progress.percent,
    transferred: progress.transferred,
    total: progress.total,
    bytesPerSecond: progress.bytesPerSecond
  })
}

function logUpdater(message: string, data?: unknown): void {
  const entry = `[${new Date().toISOString()}] ${message}${data === undefined ? '' : ` ${formatLogData(data)}`}`
  console.log(`[Updater] ${message}`, data ?? '')

  try {
    const logDir = join(app.getPath('userData'), 'logs')
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
    appendFileSync(join(logDir, 'updater.log'), `${entry}\n`, 'utf-8')
  } catch (err) {
    console.error('[Updater] Failed to write updater log', err)
  }
}

function createUpdaterLogger(): Logger {
  return {
    info: (message?: unknown) => logUpdater('electron-updater info', message),
    warn: (message?: unknown) => logUpdater('electron-updater warn', message),
    error: (message?: unknown) => logUpdater('electron-updater error', message),
    debug: (message: string) => logUpdater('electron-updater debug', message)
  }
}

function formatLogData(data: unknown): string {
  if (data instanceof Error) {
    return JSON.stringify({
      name: data.name,
      message: data.message,
      stack: data.stack
    })
  }

  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}
