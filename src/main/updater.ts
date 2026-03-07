import { autoUpdater } from 'electron-updater'
import { app, BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { join, dirname, basename } from 'path'
import { execSync } from 'child_process'
import type { DatabaseManager } from './database'

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours

/** Whether initUpdater has already been called */
let updaterInitialized = false

/** Path to the downloaded update file, captured from the update-downloaded event */
let downloadedFilePath: string | null = null

/** Version of the available update */
let pendingUpdateVersion: string | null = null

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
 * Safe to call multiple times — only the first call has an effect.
 */
export function initUpdater(mainWindow: BrowserWindow): void {
  if (updaterInitialized) return
  updaterInitialized = true

  // Allow update checks in dev mode (uses dev-app-update.yml)
  autoUpdater.forceDevUpdateConfig = true

  // Don't auto-download — let the user decide
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('update-available', (info) => {
    pendingUpdateVersion = info.version
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

  autoUpdater.on('update-downloaded', (info) => {
    // Capture the downloaded file path for manual install on macOS
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dlPath = (info as any).downloadedFile as string | undefined
    console.log('[Updater] update-downloaded event, downloadedFile from info:', dlPath)
    if (dlPath && existsSync(dlPath)) {
      downloadedFilePath = dlPath
    }
    // Also try to find it in the cache as a fallback
    if (!downloadedFilePath) {
      downloadedFilePath = findCachedUpdate()
    }
    console.log('[Updater] Final downloadedFilePath:', downloadedFilePath)

    if (mainWindow.isDestroyed()) return
    mainWindow.webContents.send('update:downloaded')
  })

  autoUpdater.on('error', (err) => {
    console.error('[Updater] autoUpdater error:', err?.message)

    // On macOS, Squirrel.Mac code signature errors happen AFTER the file is
    // downloaded.  The file is still usable for manual install, so if we
    // detect this specific error we still treat the download as successful.
    if (
      process.platform === 'darwin' &&
      err?.message?.includes('Code signature') &&
      !downloadedFilePath
    ) {
      downloadedFilePath = findCachedUpdate()
      if (downloadedFilePath) {
        console.log('[Updater] Found cached update despite Squirrel error:', downloadedFilePath)
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update:downloaded')
        }
        return // Don't send error to renderer — we can still install manually
      }
    }

    if (mainWindow.isDestroyed()) return
    mainWindow.webContents.send('update:error', err?.message ?? 'Unknown error')
  })
}

/**
 * Set the downloaded file path (used when the IPC handler catches Squirrel errors).
 */
export function setDownloadedFilePath(path: string): void {
  downloadedFilePath = path
}

/**
 * Scan the electron-updater cache directory for a pending update ZIP.
 */
export function findCachedUpdate(): string | null {
  try {
    const cacheDir = join(app.getPath('appData'), '..', 'Caches', `${app.getName()}-updater`, 'pending')
    console.log('[Updater] Scanning cache dir:', cacheDir)
    if (!existsSync(cacheDir)) {
      // Try alternate path
      const altCacheDir = join(app.getPath('home'), 'Library', 'Caches', `${app.getName()}-updater`, 'pending')
      console.log('[Updater] Trying alternate cache dir:', altCacheDir)
      if (!existsSync(altCacheDir)) return null
      return findZipInDir(altCacheDir)
    }
    return findZipInDir(cacheDir)
  } catch (err) {
    console.error('[Updater] Error scanning cache:', err)
    return null
  }
}

function findZipInDir(dir: string): string | null {
  const files = readdirSync(dir).filter((f) => f.endsWith('.zip'))
  console.log('[Updater] Found ZIP files in cache:', files)
  // Prefer the file matching the pending version
  if (pendingUpdateVersion) {
    const match = files.find((f) => f.includes(pendingUpdateVersion!))
    if (match) return join(dir, match)
  }
  // Fallback: most recent zip
  if (files.length > 0) return join(dir, files[files.length - 1])
  return null
}

/**
 * Check for updates. Returns whether the check was actually performed.
 */
export async function checkForUpdates(): Promise<boolean> {
  if (!app.isPackaged) {
    console.log('[Updater] Dev mode — using dev-app-update.yml for update check')
  }
  const result = await autoUpdater.checkForUpdates()
  return result !== null
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
  console.log('[Updater] quitAndInstall called')
  console.log('[Updater] platform:', process.platform)
  console.log('[Updater] downloadedFilePath:', downloadedFilePath)

  // If we don't have the path yet, try scanning cache
  if (!downloadedFilePath || !existsSync(downloadedFilePath)) {
    downloadedFilePath = findCachedUpdate()
    console.log('[Updater] After cache scan, downloadedFilePath:', downloadedFilePath)
  }

  // Remove close interceptors so windows can close
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.removeAllListeners('close')
  }
  app.removeAllListeners('window-all-closed')

  // On macOS, do a manual install (bypasses Squirrel.Mac code signing requirement)
  if (process.platform === 'darwin' && downloadedFilePath && existsSync(downloadedFilePath)) {
    try {
      macOSManualInstall(downloadedFilePath)
      return
    } catch (err) {
      console.error('[Updater] macOS manual install failed:', err)
    }
  }

  // Non-macOS or fallback
  console.log('[Updater] Falling back to autoUpdater.quitAndInstall()')
  autoUpdater.quitAndInstall(false, true)
}

/**
 * Manual install for macOS: extract the downloaded ZIP, replace the current
 * .app bundle, and relaunch — all without requiring code signing.
 */
function macOSManualInstall(zipPath: string): void {
  // Resolve the current .app bundle path
  // app.getAppPath() → /Applications/20x.app/Contents/Resources/app.asar
  const appPath = app.getAppPath()
  console.log('[Updater] app.getAppPath():', appPath)

  const appBundleSplit = appPath.split('.app/')
  if (appBundleSplit.length < 2) {
    throw new Error(`Cannot determine .app bundle from: ${appPath}`)
  }
  const appBundlePath = appBundleSplit[0] + '.app'
  const appBundleDir = dirname(appBundlePath)
  const appBundleName = basename(appBundlePath)

  // Extract to temp dir
  const tmpDir = join(app.getPath('temp'), '20x-update-extract')
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true })
  }
  mkdirSync(tmpDir, { recursive: true })

  console.log('[Updater] Extracting:', zipPath)
  console.log('[Updater] To:', tmpDir)
  console.log('[Updater] Current bundle:', appBundlePath)

  execSync(`ditto -xk "${zipPath}" "${tmpDir}"`)

  // Find the .app inside the extracted dir
  const extracted = readdirSync(tmpDir).filter((f) => f.endsWith('.app'))
  if (extracted.length === 0) {
    throw new Error('No .app found in extracted update')
  }
  const newAppPath = join(tmpDir, extracted[0])
  console.log('[Updater] Extracted app:', newAppPath)

  // Spawn a detached script that waits for this process to exit,
  // swaps the .app bundle, and relaunches
  const targetPath = join(appBundleDir, appBundleName)
  const script = [
    `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.1; done`,
    `rm -rf "${appBundlePath}"`,
    `mv "${newAppPath}" "${targetPath}"`,
    `rm -rf "${tmpDir}"`,
    `xattr -cr "${targetPath}" 2>/dev/null`,
    `open "${targetPath}"`
  ].join(' && ')

  console.log('[Updater] Spawning install script and exiting...')

  spawn('bash', ['-c', script], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env }
  }).unref()

  app.exit(0)
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
