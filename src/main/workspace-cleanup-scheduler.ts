import { BrowserWindow } from 'electron'
import type { DatabaseManager } from './database'
import { REPOS_DIR, WORKSPACES_DIR, listWorkspaceDirs } from './workspace-paths'
import { readDiskSpace, workspacePressureWarning } from './workspace-process-cleanup'
import { runWorkspaceCleanupWorker } from './workspace-cleanup-worker-client'
import {
  NODE_MODULES_GC_DAYS_KEY,
  NODE_MODULES_GC_ENABLED_KEY,
  NODE_MODULES_GC_LAST_RUN_KEY,
  DEFAULT_NODE_MODULES_GC_DAYS
} from './workspace-node-modules-gc'

/** Combined outcome of a cleanup run. */
export interface CleanupResult {
  cleaned: number
  retiredWorkspaces: number
  errors: string[]
  nodeModulesCleaned: number
  nextCachesCleaned: number
  turboFilesCleaned: number
  turboBytesCleaned: number
}

/**
 * WorkspaceCleanupScheduler - Automatic cleanup of orphaned workspaces
 *
 * Runs once daily (every 24 hours). On each tick:
 * 1. Checks if auto-cleanup is enabled via settings
 * 2. Removes old orphaned workspace directories and non-output files of finished tasks
 * 3. Prunes idle `node_modules` and `.next/cache` directories at any depth, for tasks in ANY status
 *    (own enable flag + retention, on by default — deps reinstall from package.json)
 * 4. Prunes old Turbo cache files
 *
 * Settings:
 * - `workspace_autocleanup_enabled` — "true"/"false" (default: "false")
 * - `workspace_autocleanup_days` — age of orphaned directories, finished workspaces, and Turbo files before removal (default: 7)
 * - `workspace_nodemodules_gc_enabled` — "true"/"false" (default: "true")
 * - `workspace_nodemodules_gc_days` — days of dependency or cache inactivity before pruning (default: 7)
 */
export class WorkspaceCleanupScheduler {
  private dbManager: DatabaseManager
  private intervalId: NodeJS.Timeout | null = null
  private mainWindow: BrowserWindow | null = null
  private isRunning = false

  /** Check every hour, but only actually clean once per day */
  private readonly CHECK_INTERVAL = 60 * 60 * 1000 // 1 hour
  private readonly DEFAULT_RETENTION_DAYS = 7

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager
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
   * Manually trigger a cleanup run. Returns the number of workspaces cleaned
   * plus retired finished workspaces and the number of idle cache directories and files pruned.
   * Rejects if a cleanup is already in progress (prevents concurrent runs).
   */
  async runNow(): Promise<CleanupResult> {
    if (this.isRunning) {
      return { cleaned: 0, retiredWorkspaces: 0, errors: ['Cleanup is already in progress'], nodeModulesCleaned: 0, nextCachesCleaned: 0, turboFilesCleaned: 0, turboBytesCleaned: 0 }
    }
    this.isRunning = true
    this.sendToRenderer('workspace:cleanup-progress', { phase: 'starting', current: 0, total: 0 })
    try {
      const result = await this.doCleanup(true)
      const nm = await this.runNodeModulesPhase(true)
      const retired = await this.runFinishedWorkspacePhase(true)
      const turbo = await this.runTurboCachePhase(true)
      const combined: CleanupResult = {
        cleaned: result.cleaned,
        retiredWorkspaces: retired.workspaces,
        errors: [...result.errors, ...nm.errors, ...retired.errors, ...turbo.errors],
        nodeModulesCleaned: nm.pruned,
        nextCachesCleaned: nm.nextCachesPruned,
        turboFilesCleaned: turbo.files,
        turboBytesCleaned: turbo.bytes
      }
      this.sendToRenderer('workspace:cleanup-progress', {
        phase: 'done',
        current: combined.cleaned,
        total: combined.cleaned,
        cleaned: combined.cleaned,
        retiredWorkspaces: combined.retiredWorkspaces,
        nodeModulesCleaned: combined.nodeModulesCleaned,
        nextCachesCleaned: combined.nextCachesCleaned,
        turboFilesCleaned: combined.turboFilesCleaned,
        turboBytesCleaned: combined.turboBytesCleaned,
        errors: combined.errors
      })
      return combined
    } finally {
      this.isRunning = false
    }
  }

  // ── Core Logic ──────────────────────────────────────────────

  private async runCleanup(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true

    try {
      // Idle dependency and cache pruning has its own flag and schedule: it is safe for
      // every task status (only regenerable deps go), so it runs whether or not
      // orphaned-workspace auto-cleanup is enabled.
      await this.runNodeModulesGcAuto()

      // Check if auto-cleanup is enabled
      const enabled = this.dbManager.getSetting('workspace_autocleanup_enabled')
      if (enabled !== 'true') {
        // Keep disk-pressure reporting even when orphan cleanup is disabled.
        this.reportWorkspaceCount()
        return
      }

      // Check if we already ran today
      const lastRun = this.dbManager.getSetting('workspace_autocleanup_last_run')
      if (lastRun) {
        const lastRunDate = new Date(lastRun)
        const now = new Date()
        const hoursSinceLastRun = (now.getTime() - lastRunDate.getTime()) / (1000 * 60 * 60)
        if (hoursSinceLastRun < 23) return // Run at most once per day
      }

      const result = await this.doCleanup(false)
      const retired = await this.runFinishedWorkspacePhase(false)
      const turbo = await this.runTurboCachePhase(false)

      // Record last run time
      this.dbManager.setSetting('workspace_autocleanup_last_run', new Date().toISOString())

      if (result.cleaned > 0 || retired.workspaces > 0 || turbo.files > 0) {
        console.log(`[WorkspaceCleanup] Cleaned ${result.cleaned} orphaned workspace(s), retired ${retired.workspaces} workspace(s), and pruned ${turbo.files} Turbo cache file(s)`)
        this.sendToRenderer('workspace:cleanup-complete', {
          cleaned: result.cleaned,
          retiredWorkspaces: retired.workspaces,
          turboFilesCleaned: turbo.files,
          turboBytesCleaned: turbo.bytes,
          errors: [...result.errors, ...retired.errors, ...turbo.errors]
        })
      }
      if (retired.errors.length > 0) console.warn(`[WorkspaceCleanup] Workspace retirement errors: ${retired.errors.join('; ')}`)
      if (turbo.errors.length > 0) console.warn(`[WorkspaceCleanup] Turbo cache errors: ${turbo.errors.join('; ')}`)
    } catch (err) {
      console.error('[WorkspaceCleanup] Error in runCleanup:', err)
    } finally {
      this.isRunning = false
    }
  }

  private async doCleanup(reportProgress: boolean): Promise<{ cleaned: number; errors: string[] }> {
    // Keep task roots and artifacts. A separate worker phase retires all
    // non-output files of finished tasks after the retention period.
    const allTasks = this.dbManager.getTasks()
    if (allTasks.length === 0) {
      // An unavailable database also reads as an empty task list. Do not infer
      // that every workspace is orphaned when ownership cannot be verified.
      this.reportWorkspaceCount()
      return { cleaned: 0, errors: [] }
    }
    const result = await runWorkspaceCleanupWorker({
      kind: 'orphans',
      workspacesRoot: WORKSPACES_DIR,
      taskIds: allTasks.map((task) => task.id),
      retentionDays: this.getRetentionDays()
    }, reportProgress ? (progress) => this.sendToRenderer('workspace:cleanup-progress', progress) : undefined)
    if (result.kind !== 'orphans') throw new Error('Unexpected workspace cleanup result')
    this.reportWorkspaceCount()
    return result
  }

  /**
   * Reports how many workspaces are left. Nothing bounds this count: every agent
   * run makes another clone with its own `node_modules`. On the machine the
   * process leak was diagnosed on there were 397 of them holding 313 GB, which
   * is a disk and inode problem in its own right. Counting it is the smallest
   * honest thing to do about it.
   */
  private reportWorkspaceCount(): void {
    const dirs = listWorkspaceDirs()
    if (dirs === null) return
    const pressure = workspacePressureWarning({ count: dirs.length, disk: readDiskSpace(WORKSPACES_DIR) })
    if (!pressure) return
    // Console only. An earlier version also sent `workspace:count-warning` to
    // the renderer, which was dead code: no preload bridge carries it and no
    // component listens, so it reached nobody while looking like it reached
    // someone. Surfacing this in the UI is a real change — a preload channel, a
    // component, and a decision about how insistent it should be — and it wants
    // to be made deliberately rather than smuggled in with a process fix.
    console.warn(`[WorkspaceCleanup] ${pressure}`)
  }

  private getRetentionDays(): number {
    const setting = this.dbManager.getSetting('workspace_autocleanup_days')
    if (setting) {
      const parsed = parseInt(setting, 10)
      if (!isNaN(parsed) && parsed >= 1) return parsed
    }
    return this.DEFAULT_RETENTION_DAYS
  }

  private async runFinishedWorkspacePhase(reportProgress: boolean): Promise<{ workspaces: number; errors: string[] }> {
    const result = await runWorkspaceCleanupWorker({
      kind: 'finished-workspaces',
      workspacesRoot: WORKSPACES_DIR,
      tasks: this.dbManager.getTasks().map(({ id, status, parent_task_id, updated_at }) => ({ id, status, parent_task_id, updated_at })),
      inactiveDays: this.getRetentionDays()
    }, reportProgress ? (progress) => this.sendToRenderer('workspace:cleanup-progress', progress) : undefined)
    if (result.kind !== 'finished-workspaces') throw new Error('Unexpected finished workspace cleanup result')
    return result
  }

  private async runTurboCachePhase(reportProgress: boolean): Promise<{ files: number; bytes: number; errors: string[] }> {
    const result = await runWorkspaceCleanupWorker({
      kind: 'turbo',
      reposRoot: REPOS_DIR,
      workspacesRoot: WORKSPACES_DIR,
      inactiveDays: this.getRetentionDays()
    }, reportProgress ? (progress) => this.sendToRenderer('workspace:cleanup-progress', progress) : undefined)
    if (result.kind !== 'turbo') throw new Error('Unexpected Turbo cache cleanup result')
    return result
  }

  // ── Idle node_modules GC ──────────────────────────────

  private isNodeModulesGcEnabled(): boolean {
    const setting = this.dbManager.getSetting(NODE_MODULES_GC_ENABLED_KEY)
    if (setting === undefined || setting === null) return true
    return setting === 'true'
  }

  private getNodeModulesGcDays(): number {
    const setting = this.dbManager.getSetting(NODE_MODULES_GC_DAYS_KEY)
    if (setting) {
      const parsed = parseInt(setting, 10)
      if (!isNaN(parsed) && parsed >= 1) return parsed
    }
    return DEFAULT_NODE_MODULES_GC_DAYS
  }

  /**
   * Automatic (scheduled) node_modules pass: own enable flag, at most once per day.
   * Runs independently of orphaned-workspace auto-cleanup.
   */
  private async runNodeModulesGcAuto(): Promise<void> {
    if (!this.isNodeModulesGcEnabled()) return
    const lastRun = this.dbManager.getSetting(NODE_MODULES_GC_LAST_RUN_KEY)
    if (lastRun) {
      const hoursSinceLastRun = (Date.now() - new Date(lastRun).getTime()) / (1000 * 60 * 60)
      if (hoursSinceLastRun < 23) return
    }
    const nm = await this.runNodeModulesPhase(false)
    this.dbManager.setSetting(NODE_MODULES_GC_LAST_RUN_KEY, new Date().toISOString())
    if (nm.pruned > 0 || nm.nextCachesPruned > 0) {
      console.log(`[WorkspaceCleanup] Pruned ${nm.pruned} idle node_modules and ${nm.nextCachesPruned} .next/cache folders`)
    }
    if (nm.errors.length > 0) {
      console.warn(`[WorkspaceCleanup] node_modules prune errors: ${nm.errors.join('; ')}`)
    }
  }

  /**
   * One dependency and cache pruning pass over every workspace on disk, regardless of
   * task status. Workspaces with a live process rooted in them are skipped; when
   * liveness cannot be observed (Windows, unreadable process table), tasks in an
   * active status are skipped instead — a build lock inside node_modules must
   * never be pulled out from under a running agent.
   */
  private async runNodeModulesPhase(reportProgress: boolean): Promise<{ pruned: number; nextCachesPruned: number; errors: string[] }> {
    if (!this.isNodeModulesGcEnabled()) return { pruned: 0, nextCachesPruned: 0, errors: [] }
    const result = await runWorkspaceCleanupWorker({
      kind: 'node-modules',
      workspacesRoot: WORKSPACES_DIR,
      inactiveDays: this.getNodeModulesGcDays(),
      tasks: this.dbManager.getTasks().map((task) => ({ id: task.id, status: task.status }))
    }, reportProgress ? (progress) => this.sendToRenderer('workspace:cleanup-progress', progress) : undefined)
    if (result.kind !== 'node-modules') throw new Error('Unexpected node_modules cleanup result')
    return result
  }

  private sendToRenderer(channel: string, data: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data)
    }
  }
}
