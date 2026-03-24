import { app, dialog } from 'electron'
import { appendFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

let logPath: string

function getLogPath(): string {
  if (!logPath) {
    const logDir = join(app.getPath('userData'), 'logs')
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
    logPath = join(logDir, 'crash.log')
  }
  return logPath
}

function formatError(error: Error | string): string {
  const timestamp = new Date().toISOString()
  const separator = '─'.repeat(60)
  if (typeof error === 'string') {
    return `\n${separator}\n[${timestamp}] CRASH\n${error}\n`
  }
  return `\n${separator}\n[${timestamp}] ${error.name || 'Error'}: ${error.message}\nStack: ${error.stack || 'N/A'}\n`
}

function logCrash(error: Error | string): void {
  try {
    const entry = formatError(error)
    appendFileSync(getLogPath(), entry, 'utf-8')
    console.error('[CrashLogger]', entry)
  } catch {
    // Last resort — can't even write to disk
    console.error('[CrashLogger] Failed to write crash log:', error)
  }
}

/**
 * Initialize crash logging. Call this early in app startup.
 * Catches uncaught exceptions, unhandled rejections, and GPU/render process crashes.
 */
export function initCrashLogger(): void {
  // Write initial header
  try {
    const header = `\n${'═'.repeat(60)}\n20x v${app.getVersion()} — Session started ${new Date().toISOString()}\nPlatform: ${process.platform} ${process.arch}\nElectron: ${process.versions.electron}\nNode: ${process.versions.node}\n${'═'.repeat(60)}\n`
    appendFileSync(getLogPath(), header, 'utf-8')
  } catch { /* ignore */ }

  // Uncaught exceptions in main process
  process.on('uncaughtException', (error) => {
    logCrash(error)

    // Show a user-friendly dialog
    try {
      dialog.showErrorBox(
        '20x — Unexpected Error',
        `An unexpected error occurred. The app may need to be restarted.\n\nError: ${error.message}\n\nA crash log has been saved to:\n${getLogPath()}`
      )
    } catch { /* dialog may fail if app isn't ready */ }
  })

  // Unhandled promise rejections
  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason))
    logCrash(error)
  })

  // GPU process crash
  app.on('gpu-process-crashed' as never, (_event: unknown, killed: boolean) => {
    logCrash(`GPU process crashed (killed: ${killed})`)
  })

  // Renderer process crash
  app.on('render-process-gone', (_event, _webContents, details) => {
    logCrash(`Renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`)
  })

  // Child process crash
  app.on('child-process-gone', (_event, details) => {
    logCrash(`Child process gone: type=${details.type}, reason=${details.reason}, name=${details.name || 'unknown'}`)
  })

  console.log(`[CrashLogger] Initialized. Log path: ${getLogPath()}`)
}

/**
 * Get the path to the crash log file.
 */
export function getCrashLogPath(): string {
  return getLogPath()
}
