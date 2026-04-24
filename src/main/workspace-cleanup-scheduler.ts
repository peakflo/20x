import { BrowserWindow, app } from 'electron'
import { existsSync, readdirSync, statSync, rmSync } from 'fs'
import { join } from 'path'
import type { DatabaseManager } from './database'
import type { WorktreeManager } from './worktree-manager'
import { TaskStatus } from '../shared/constants'

const WORKSPACES_DIR = join(app.getPath('userData'), 'workspaces')

/**
 * WorkspaceCleanupScheduler - Automatic cleanup of old completed task workspaces
 *
 * Runs once daily (every 24 hours). On each tick:
 * 1. Checks if auto-cleanup is enabled via settings
 * 2. Queries completed tasks where `updated_at` is older than the configured retention period
 * 3. Cleans up worktrees and workspace directories for those tasks
 * 4. Also removes orphaned workspace directories (no matching task in DB)
 *
 * Settings:
 * - `workspace_autocleanup_enabled` — "true"/"false" (default: "false")
 * - `workspace_autocleanup_days` — number of days after completion (default: 7)
 */
export class WorkspaceCleanupScheduler {
  private dbManager: DatabaseManager
  private worktreeManager: WorktreeManager
  private intervalId: NodeJS.Timeout | null = null
  private mainWindow: BrowserWindow | null = null
  private isRunning = false

  /** Check every hour, but only actually clean once per day */
  private readonly CHECK_INTERVAL = 60 * 60 * 1000 // 1 hour
  private readonly DEFAULT_RETENTION_DAYS = 7

  constructor(dbManager: DatabaseManager, worktreeManager: WorktreeManager) {
    this.dbManager = dbManager
    this.worktreeManager = worktreeManager
  }

  start(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    console.log('[WorkspaceCleanup] Starting scheduler...')

    // Run once on startup (delayed by 2 minutes to not slow down app launch)
    setTimeout(() => {
      this.runCleanup()
    }, 2 * 60 * 1000)

    // Then check every hour
    this.intervalId = setInterval(() => {
      this.runCleanup()
    }, this.CHECK_INTERVAL)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      console.log('[WorkspaceCleanup] Scheduler stopped')
    }
  }

  /**
   * Manually trigger a cleanup run. Returns the number of workspaces cleaned.
   * Rejects if a cleanup is already in progress (prevents concurrent runs).
   */
  async runNow(): Promise<{ cleaned: number; errors: string[] }> {
    if (this.isRunning) {
      return { cleaned: 0, errors: ['Cleanup is already in progress'] }
    }
    this.isRunning = true
    this.sendToRenderer('workspace:cleanup-progress', { phase: 'starting', current: 0, total: 0 })
    try {
      const result = await this.doCleanup(true)
      this.sendToRenderer('workspace:cleanup-progress', {
        phase: 'done',
        current: result.cleaned,
        total: result.cleaned,
        cleaned: result.cleaned,
        errors: result.errors
      })
      return result
    } finally {
      this.isRunning = false
    }
  }

  // ── Core Logic ──────────────────────────────────────────────

  private async runCleanup(): Promise<void> {
    if (this.isRunning) return

    try {
      // Check if auto-cleanup is enabled
      const enabled = this.dbManager.getSetting('workspace_autocleanup_enabled')
      if (enabled !== 'true') return

      // Check if we already ran today
      const lastRun = this.dbManager.getSetting('workspace_autocleanup_last_run')
      if (lastRun) {
        const lastRunDate = new Date(lastRun)
        const now = new Date()
        const hoursSinceLastRun = (now.getTime() - lastRunDate.getTime()) / (1000 * 60 * 60)
        if (hoursSinceLastRun < 23) return // Run at most once per day
      }

      this.isRunning = true
      const result = await this.doCleanup(false)

      // Record last run time
      this.dbManager.setSetting('workspace_autocleanup_last_run', new Date().toISOString())

      if (result.cleaned > 0) {
        console.log(`[WorkspaceCleanup] Cleaned ${result.cleaned} workspace(s)`)
        this.sendToRenderer('workspace:cleanup-complete', {
          cleaned: result.cleaned,
          errors: result.errors
        })
      }
    } catch (err) {
      console.error('[WorkspaceCleanup] Error in runCleanup:', err)
    } finally {
      this.isRunning = false
    }
  }

  private async doCleanup(reportProgress: boolean): Promise<{ cleaned: number; errors: string[] }> {
    const retentionDays = this.getRetentionDays()
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    const org = this.dbManager.getSetting('github_org') || ''

    let cleaned = 0
    const errors: string[] = []

    // Phase 1: Clean workspaces for completed tasks past retention
    const allTasks = this.dbManager.getTasks()
    const completedTasks = allTasks.filter(
      (t) =>
        t.status === TaskStatus.Completed &&
        new Date(t.updated_at) < cutoffDate
    )

    // Count eligible workspaces (ones that actually exist on disk)
    const eligibleTasks = completedTasks.filter((t) =>
      existsSync(join(WORKSPACES_DIR, t.id))
    )

    // Count orphaned directories
    let orphanDirs: string[] = []
    try {
      if (existsSync(WORKSPACES_DIR)) {
        const taskIds = new Set(allTasks.map((t) => t.id))
        const dirs = readdirSync(WORKSPACES_DIR, { withFileTypes: true })
        orphanDirs = dirs
          .filter((d) => d.isDirectory() && !taskIds.has(d.name))
          .map((d) => d.name)
          .filter((name) => {
            try {
              return statSync(join(WORKSPACES_DIR, name)).mtime < cutoffDate
            } catch {
              return false
            }
          })
      }
    } catch {
      // ignore scan errors for counting
    }

    const total = eligibleTasks.length + orphanDirs.length
    let processed = 0

    if (reportProgress) {
      this.sendToRenderer('workspace:cleanup-progress', {
        phase: 'scanning',
        current: 0,
        total,
        message: `Found ${total} workspace${total !== 1 ? 's' : ''} to clean`
      })
    }

    for (const task of eligibleTasks) {
      const taskDir = join(WORKSPACES_DIR, task.id)

      if (reportProgress) {
        this.sendToRenderer('workspace:cleanup-progress', {
          phase: 'cleaning',
          current: processed,
          total,
          message: `Cleaning "${task.title}"...`
        })
      }

      try {
        if (task.repos.length > 0 && org) {
          await this.worktreeManager.cleanupTaskWorkspace(
            task.id,
            task.repos.map((r) => ({ fullName: r })),
            org,
            true
          )
        } else {
          // No repos — just remove the workspace directory
          rmSync(taskDir, { recursive: true, force: true })
        }
        cleaned++
        console.log(`[WorkspaceCleanup] Cleaned workspace for completed task "${task.title}" (${task.id})`)
      } catch (err) {
        const message = `Failed to clean workspace for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`
        console.error(`[WorkspaceCleanup] ${message}`)
        errors.push(message)
      }
      processed++
    }

    // Phase 2: Clean orphaned workspace directories (no matching task in DB)
    for (const name of orphanDirs) {
      const dirPath = join(WORKSPACES_DIR, name)

      if (reportProgress) {
        this.sendToRenderer('workspace:cleanup-progress', {
          phase: 'cleaning',
          current: processed,
          total,
          message: `Cleaning orphaned workspace ${name.substring(0, 12)}...`
        })
      }

      try {
        rmSync(dirPath, { recursive: true, force: true })
        cleaned++
        console.log(`[WorkspaceCleanup] Cleaned orphaned workspace directory: ${name}`)
      } catch (err) {
        const message = `Failed to clean orphaned directory ${name}: ${err instanceof Error ? err.message : String(err)}`
        console.error(`[WorkspaceCleanup] ${message}`)
        errors.push(message)
      }
      processed++
    }

    return { cleaned, errors }
  }

  private getRetentionDays(): number {
    const setting = this.dbManager.getSetting('workspace_autocleanup_days')
    if (setting) {
      const parsed = parseInt(setting, 10)
      if (!isNaN(parsed) && parsed >= 1) return parsed
    }
    return this.DEFAULT_RETENTION_DAYS
  }

  private sendToRenderer(channel: string, data: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data)
    }
  }
}
