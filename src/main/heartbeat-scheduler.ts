import { BrowserWindow, Notification } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import type { DatabaseManager, TaskRecord } from './database'
import type { AgentManager } from './agent-manager'
import { HeartbeatStatus, HEARTBEAT_OK_TOKEN, HEARTBEAT_DEFAULTS } from '../shared/constants'

const execFileAsync = promisify(execFile)

/**
 * HeartbeatScheduler - Periodic monitoring of tasks in ready_for_review status
 *
 * Inspired by OpenClaw's heartbeat pattern, this scheduler:
 * 1. Ticks every 60 seconds
 * 2. Queries tasks with heartbeat_enabled=1 and heartbeat_next_check_at <= NOW()
 * 3. Spawns lightweight agent sessions that read heartbeat.md from the task workspace
 * 4. Parses results: HEARTBEAT_OK (no notification) vs attention needed (notify user)
 * 5. Logs results to heartbeat_logs table
 *
 * ## heartbeat.md
 * A markdown file written by the agent when it finishes a task. Contains a checklist
 * of items to periodically monitor (e.g., PR comments, CI status, issue updates).
 *
 * ## Lifecycle
 * - Created: Agent writes heartbeat.md → auto-enabled on task completion
 * - Active: Runs while task is in ready_for_review status
 * - Terminated: Task moves to completed, or heartbeat.md is deleted
 */
export class HeartbeatScheduler {
  private dbManager: DatabaseManager
  private agentManager: AgentManager
  private intervalId: NodeJS.Timeout | null = null
  private mainWindow: BrowserWindow | null = null
  private readonly CHECK_INTERVAL = HEARTBEAT_DEFAULTS.checkIntervalMs
  private readonly MAX_CONSECUTIVE_ERRORS = HEARTBEAT_DEFAULTS.maxConsecutiveErrors

  /** Track in-progress heartbeat sessions to avoid duplicates */
  private inProgress: Set<string> = new Set()

  constructor(dbManager: DatabaseManager, agentManager: AgentManager) {
    this.dbManager = dbManager
    this.agentManager = agentManager
  }

  start(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    console.log('[HeartbeatScheduler] Starting scheduler...')

    // Run immediately on startup
    this.checkHeartbeats()

    // Then run every 60 seconds
    this.intervalId = setInterval(() => {
      this.checkHeartbeats()
    }, this.CHECK_INTERVAL)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      console.log('[HeartbeatScheduler] Scheduler stopped')
    }
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Enable heartbeat for a task. Sets next check time based on interval.
   */
  enableHeartbeat(taskId: string, intervalMinutes?: number): void {
    const interval = intervalMinutes ?? this.getDefaultInterval()
    const now = new Date()
    const nextCheck = new Date(now.getTime() + interval * 60_000)

    this.dbManager.updateTask(taskId, {
      heartbeat_enabled: true,
      heartbeat_interval_minutes: interval,
      heartbeat_next_check_at: nextCheck.toISOString()
    })

    console.log(`[HeartbeatScheduler] Enabled heartbeat for task ${taskId}, interval: ${interval}min, next: ${nextCheck.toISOString()}`)
  }

  /**
   * Disable heartbeat for a task.
   */
  disableHeartbeat(taskId: string): void {
    this.dbManager.updateTask(taskId, {
      heartbeat_enabled: false,
      heartbeat_next_check_at: null
    })

    console.log(`[HeartbeatScheduler] Disabled heartbeat for task ${taskId}`)
  }

  /**
   * Manually trigger a heartbeat check for a specific task.
   */
  async runNow(taskId: string): Promise<void> {
    const task = this.dbManager.getTask(taskId)
    if (!task) {
      console.warn(`[HeartbeatScheduler] runNow: task ${taskId} not found`)
      return
    }
    await this.runHeartbeat(task)
  }

  /**
   * Get the heartbeat.md file path for a task.
   */
  getHeartbeatFilePath(taskId: string): string {
    const workspaceDir = this.dbManager.getWorkspaceDir(taskId)
    return join(workspaceDir, 'heartbeat.md')
  }

  /**
   * Check if a heartbeat.md file exists for a task.
   */
  hasHeartbeatFile(taskId: string): boolean {
    return existsSync(this.getHeartbeatFilePath(taskId))
  }

  /**
   * Read the heartbeat.md content for a task.
   */
  readHeartbeatFile(taskId: string): string | null {
    const filePath = this.getHeartbeatFilePath(taskId)
    if (!existsSync(filePath)) return null
    try {
      const content = readFileSync(filePath, 'utf-8').trim()
      // Skip empty files or files with only headers (OpenClaw pattern)
      if (!content || /^(#[^\n]*\n?\s*)*$/.test(content)) return null
      return content
    } catch {
      return null
    }
  }

  // ── Core Logic ──────────────────────────────────────────────

  private async checkHeartbeats(): Promise<void> {
    try {
      // Check if heartbeat is globally enabled
      const globalEnabled = this.dbManager.getSetting('heartbeat_enabled_global')
      if (globalEnabled === 'false') return

      // Check active hours
      if (!this.isWithinActiveHours()) return

      // Query due tasks
      const dueTasks = this.dbManager.getHeartbeatDueTasks()

      if (dueTasks.length === 0) return

      console.log(`[HeartbeatScheduler] Found ${dueTasks.length} due heartbeat(s)`)

      // Process sequentially to avoid overloading agent quotas
      for (const task of dueTasks) {
        // Skip if already in progress
        if (this.inProgress.has(task.id)) {
          console.log(`[HeartbeatScheduler] Skipping task ${task.id} — heartbeat already in progress`)
          continue
        }

        // Verify heartbeat.md still exists
        if (!this.hasHeartbeatFile(task.id)) {
          console.log(`[HeartbeatScheduler] No heartbeat.md for task ${task.id}, disabling heartbeat`)
          this.disableHeartbeat(task.id)
          continue
        }

        try {
          await this.runHeartbeat(task)
        } catch (err) {
          console.error(`[HeartbeatScheduler] Error running heartbeat for task ${task.id}:`, err)
        }
      }
    } catch (err) {
      console.error('[HeartbeatScheduler] Error in checkHeartbeats:', err)
    }
  }

  /**
   * Run a single heartbeat check for a task.
   *
   * Cost optimization flow:
   * 1. Read heartbeat.md
   * 2. Run pre-flight checks (cheap, no LLM) — parse for GitHub URLs, check via `gh api`
   * 3. If pre-flight finds no changes → log HEARTBEAT_OK, skip LLM
   * 4. If pre-flight detects changes → spawn lightweight agent session
   * 5. Parse result → HEARTBEAT_OK or attention needed
   * 6. Log result + advance next check time (with adaptive interval)
   */
  private async runHeartbeat(task: TaskRecord): Promise<void> {
    const heartbeatContent = this.readHeartbeatFile(task.id)
    if (!heartbeatContent) {
      this.advanceNextCheck(task)
      return
    }

    this.inProgress.add(task.id)

    try {
      console.log(`[HeartbeatScheduler] Running heartbeat for task "${task.title}" (${task.id})`)

      // Phase 4.1: Pre-flight checks (cheap, no LLM)
      const preflightResult = await this.runPreflightChecks(heartbeatContent, task)
      if (preflightResult === 'no_changes') {
        console.log(`[HeartbeatScheduler] Pre-flight: no changes for task "${task.title}", skipping LLM`)
        this.logResult(task.id, HeartbeatStatus.Ok, 'Pre-flight: no changes detected (LLM skipped)')
        this.advanceNextCheck(task, true) // pass isOk=true for adaptive interval
        return
      }

      // Changes detected or pre-flight inconclusive → spawn agent session
      const prompt = this.buildHeartbeatPrompt(task, heartbeatContent)

      const agentId = this.resolveAgentId(task)
      if (!agentId) {
        console.warn(`[HeartbeatScheduler] No agent available for task ${task.id}, skipping`)
        this.logResult(task.id, HeartbeatStatus.Error, 'No agent available for heartbeat check')
        this.advanceNextCheck(task)
        return
      }

      const sessionId = await this.agentManager.startHeartbeatSession(agentId, task.id, prompt)
      const result = await this.waitForSessionResult(sessionId, task.id)
      this.handleResult(task, sessionId, result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[HeartbeatScheduler] Heartbeat error for task ${task.id}:`, message)
      this.logResult(task.id, HeartbeatStatus.Error, message)

      this.checkConsecutiveErrors(task.id)
      this.advanceNextCheck(task)
    } finally {
      this.inProgress.delete(task.id)
    }
  }

  /**
   * Build the prompt for a heartbeat agent session.
   * Kept minimal to reduce token usage.
   */
  private buildHeartbeatPrompt(task: TaskRecord, heartbeatContent: string): string {
    return `You are performing a periodic heartbeat check for task: "${task.title}"

Here are the monitoring instructions from heartbeat.md:

${heartbeatContent}

For each check item:
1. Use available tools to verify the current status
2. Note if anything needs user attention

After checking all items, respond with one of:
- If nothing needs attention: reply with exactly "${HEARTBEAT_OK_TOKEN}"
- If something needs attention: describe what needs attention clearly and concisely

Keep your response concise. This is a monitoring check, not a full work session.`
  }

  /**
   * Wait for a heartbeat session to complete and extract the result text.
   * Polls the agent session status until it transitions to idle.
   */
  private waitForSessionResult(sessionId: string, _taskId: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const TIMEOUT_MS = 5 * 60_000 // 5 minute timeout for heartbeat sessions
      const POLL_MS = 3_000 // check every 3s

      let elapsed = 0

      const timer = setInterval(() => {
        elapsed += POLL_MS

        if (elapsed >= TIMEOUT_MS) {
          clearInterval(timer)
          reject(new Error(`Heartbeat session ${sessionId} timed out after 5 minutes`))
          return
        }

        // Check if the session is still running
        const session = this.agentManager.getSession(sessionId)
        if (!session || session.status === 'idle') {
          clearInterval(timer)

          // Get the last assistant message from the session
          const lastMessage = this.agentManager.getLastAssistantMessage(sessionId)
          resolve(lastMessage || HEARTBEAT_OK_TOKEN) // Default to OK if no message
        }
      }, POLL_MS)
    })
  }

  /**
   * Handle the heartbeat result.
   */
  private handleResult(task: TaskRecord, sessionId: string, result: string): void {
    const isOk = result.includes(HEARTBEAT_OK_TOKEN)

    if (isOk) {
      console.log(`[HeartbeatScheduler] ${HEARTBEAT_OK_TOKEN} for task "${task.title}"`)
      this.logResult(task.id, HeartbeatStatus.Ok, 'All checks passed', sessionId)
      this.advanceNextCheck(task, true) // adaptive: may increase interval
    } else {
      console.log(`[HeartbeatScheduler] Attention needed for task "${task.title}": ${result.substring(0, 100)}`)
      this.logResult(task.id, HeartbeatStatus.AttentionNeeded, result.substring(0, 500), sessionId)
      this.notifyAttentionNeeded(task, result)
      this.advanceNextCheck(task, false) // reset to base interval
    }
  }

  /**
   * Send notification when heartbeat detects something needs attention.
   */
  private notifyAttentionNeeded(task: TaskRecord, summary: string): void {
    // Electron notification
    try {
      const notification = new Notification({
        title: `Heartbeat Alert: ${task.title}`,
        body: summary.substring(0, 200)
      })
      notification.show()
    } catch (err) {
      console.error('[HeartbeatScheduler] Failed to show notification:', err)
    }

    // Renderer notification
    this.sendToRenderer('heartbeat:alert', {
      taskId: task.id,
      title: task.title,
      summary: summary.substring(0, 500)
    })

    // Also trigger a task refresh so UI shows the alert
    this.sendToRenderer('tasks:refresh', {})
  }

  /**
   * Log heartbeat result to the database.
   */
  private logResult(taskId: string, status: HeartbeatStatus, summary?: string, sessionId?: string): void {
    this.dbManager.createHeartbeatLog({
      task_id: taskId,
      status,
      summary: summary ?? null,
      session_id: sessionId ?? null
    })
  }

  /**
   * Advance the next check time for a task.
   *
   * Phase 4.2: Adaptive intervals
   * - After 3+ consecutive HEARTBEAT_OK results, double the interval (up to 4x base)
   * - On attention_needed or error, reset to the configured base interval
   */
  private advanceNextCheck(task: TaskRecord, isOk?: boolean): void {
    const baseInterval = task.heartbeat_interval_minutes ?? this.getDefaultInterval()
    let effectiveInterval = baseInterval

    if (isOk) {
      // Count consecutive OKs to determine if we should slow down
      const consecutiveOks = this.countConsecutiveOks(task.id)
      if (consecutiveOks >= 6) {
        effectiveInterval = baseInterval * 4 // 4x after 6+ OKs
      } else if (consecutiveOks >= 3) {
        effectiveInterval = baseInterval * 2 // 2x after 3+ OKs
      }
    }
    // If isOk is false or undefined, use base interval (reset adaptive)

    const now = new Date()
    const nextCheck = new Date(now.getTime() + effectiveInterval * 60_000)

    this.dbManager.updateTask(task.id, {
      heartbeat_last_check_at: now.toISOString(),
      heartbeat_next_check_at: nextCheck.toISOString()
    })

    if (effectiveInterval !== baseInterval) {
      console.log(`[HeartbeatScheduler] Adaptive interval: ${effectiveInterval}min (base: ${baseInterval}min) for task ${task.id}`)
    }
  }

  /**
   * Count consecutive OK results from most recent logs.
   */
  private countConsecutiveOks(taskId: string): number {
    const logs = this.dbManager.getHeartbeatLogs(taskId, 10)
    let count = 0
    for (const log of logs) {
      if (log.status === HeartbeatStatus.Ok) count++
      else break
    }
    return count
  }

  /**
   * Check for consecutive errors and auto-disable if threshold is exceeded.
   */
  private checkConsecutiveErrors(taskId: string): void {
    const maxErrors = this.getMaxConsecutiveErrors()
    const consecutiveErrors = this.dbManager.getHeartbeatConsecutiveErrors(taskId)

    if (consecutiveErrors >= maxErrors) {
      console.log(`[HeartbeatScheduler] Auto-disabling heartbeat for task ${taskId} after ${consecutiveErrors} consecutive errors`)
      this.disableHeartbeat(taskId)

      const task = this.dbManager.getTask(taskId)
      if (task) {
        try {
          const notification = new Notification({
            title: `Heartbeat Disabled: ${task.title}`,
            body: `Heartbeat was auto-disabled after ${consecutiveErrors} consecutive errors.`
          })
          notification.show()
        } catch {
          // Notification may fail in some environments
        }

        this.sendToRenderer('heartbeat:disabled', {
          taskId,
          reason: `${consecutiveErrors} consecutive errors`
        })
      }
    }
  }

  // ── Pre-flight Checks (Phase 4.1 — cheap, no LLM) ────────

  /**
   * Parse heartbeat.md for GitHub PR/issue URLs and check for changes
   * using `gh api` directly — avoids spinning up an LLM session.
   *
   * Returns:
   * - 'no_changes': all checked items have no updates since last check
   * - 'changes_detected': something changed, need LLM to analyze
   * - 'inconclusive': couldn't determine (no URLs found, or gh cli error)
   */
  private async runPreflightChecks(heartbeatContent: string, task: TaskRecord): Promise<'no_changes' | 'changes_detected' | 'inconclusive'> {
    // Extract GitHub PR and issue URLs
    const githubUrls = this.extractGitHubUrls(heartbeatContent)

    if (githubUrls.length === 0) {
      return 'inconclusive' // No URLs to check — need LLM
    }

    const lastCheck = task.heartbeat_last_check_at
    if (!lastCheck) {
      return 'inconclusive' // First check — need LLM to establish baseline
    }

    let hasChanges = false

    for (const url of githubUrls) {
      try {
        const changed = await this.checkGitHubUrlForChanges(url, lastCheck)
        if (changed) {
          hasChanges = true
          break // One change is enough to trigger LLM
        }
      } catch {
        return 'inconclusive' // gh cli error — fall through to LLM
      }
    }

    return hasChanges ? 'changes_detected' : 'no_changes'
  }

  /**
   * Extract GitHub PR and issue URLs from heartbeat.md content.
   * Matches patterns like:
   * - https://github.com/owner/repo/pull/123
   * - https://github.com/owner/repo/issues/456
   */
  private extractGitHubUrls(content: string): Array<{ owner: string; repo: string; type: 'pull' | 'issue'; number: number }> {
    const urlRegex = /https:\/\/github\.com\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)/g
    const results: Array<{ owner: string; repo: string; type: 'pull' | 'issue'; number: number }> = []
    let match

    while ((match = urlRegex.exec(content)) !== null) {
      results.push({
        owner: match[1],
        repo: match[2],
        type: match[3] === 'pull' ? 'pull' : 'issue',
        number: parseInt(match[4], 10)
      })
    }

    return results
  }

  /**
   * Check a single GitHub PR/issue for changes since lastCheck.
   * Uses `gh api` to fetch comments and reviews updated after lastCheck.
   */
  private async checkGitHubUrlForChanges(
    url: { owner: string; repo: string; type: 'pull' | 'issue'; number: number },
    lastCheck: string
  ): Promise<boolean> {
    try {
      if (url.type === 'pull') {
        // Check PR comments
        const { stdout: commentsJson } = await execFileAsync('gh', [
          'api',
          `repos/${url.owner}/${url.repo}/pulls/${url.number}/comments`,
          '--jq', `[.[] | select(.updated_at > "${lastCheck}")] | length`
        ], { timeout: 15_000 })

        const newComments = parseInt(commentsJson.trim(), 10)
        if (newComments > 0) return true

        // Check PR reviews
        const { stdout: reviewsJson } = await execFileAsync('gh', [
          'api',
          `repos/${url.owner}/${url.repo}/pulls/${url.number}/reviews`,
          '--jq', `[.[] | select(.submitted_at > "${lastCheck}")] | length`
        ], { timeout: 15_000 })

        const newReviews = parseInt(reviewsJson.trim(), 10)
        if (newReviews > 0) return true

        // Check issue comments on the PR
        const { stdout: issueCommentsJson } = await execFileAsync('gh', [
          'api',
          `repos/${url.owner}/${url.repo}/issues/${url.number}/comments`,
          '--jq', `[.[] | select(.updated_at > "${lastCheck}")] | length`
        ], { timeout: 15_000 })

        const newIssueComments = parseInt(issueCommentsJson.trim(), 10)
        return newIssueComments > 0
      } else {
        // Check issue comments
        const { stdout: commentsJson } = await execFileAsync('gh', [
          'api',
          `repos/${url.owner}/${url.repo}/issues/${url.number}/comments`,
          '--jq', `[.[] | select(.updated_at > "${lastCheck}")] | length`
        ], { timeout: 15_000 })

        const newComments = parseInt(commentsJson.trim(), 10)
        return newComments > 0
      }
    } catch (err) {
      console.warn(`[HeartbeatScheduler] Pre-flight check failed for ${url.owner}/${url.repo}#${url.number}:`, err)
      throw err // Signal inconclusive
    }
  }

  // ── Helpers ──────────────────────────────────────────────

  /**
   * Resolve which agent to use for heartbeat. Priority:
   * 1. Setting: heartbeat_agent_id (dedicated cheap agent)
   * 2. Task's own agent_id
   * 3. Default agent
   */
  private resolveAgentId(task: TaskRecord): string | null {
    // Check for dedicated heartbeat agent
    const heartbeatAgentId = this.dbManager.getSetting('heartbeat_agent_id')
    if (heartbeatAgentId) {
      const agent = this.dbManager.getAgent(heartbeatAgentId)
      if (agent) return heartbeatAgentId
    }

    // Use task's own agent
    if (task.agent_id) {
      return task.agent_id
    }

    // Fall back to default agent
    const agents = this.dbManager.getAgents()
    const defaultAgent = agents.find(a => a.is_default)
    return defaultAgent?.id ?? agents[0]?.id ?? null
  }

  /**
   * Check if current time is within configured active hours.
   */
  private isWithinActiveHours(): boolean {
    const start = this.dbManager.getSetting('heartbeat_active_hours_start')
    const end = this.dbManager.getSetting('heartbeat_active_hours_end')

    // No active hours configured → always active
    if (!start || !end) return true

    const now = new Date()
    const [startH, startM] = start.split(':').map(Number)
    const [endH, endM] = end.split(':').map(Number)

    const currentMinutes = now.getHours() * 60 + now.getMinutes()
    const startMinutes = startH * 60 + startM
    const endMinutes = endH * 60 + endM

    if (startMinutes <= endMinutes) {
      // Normal range (e.g., 09:00 - 18:00)
      return currentMinutes >= startMinutes && currentMinutes <= endMinutes
    } else {
      // Overnight range (e.g., 22:00 - 06:00)
      return currentMinutes >= startMinutes || currentMinutes <= endMinutes
    }
  }

  private getDefaultInterval(): number {
    const setting = this.dbManager.getSetting('heartbeat_default_interval')
    return setting ? parseInt(setting, 10) : HEARTBEAT_DEFAULTS.intervalMinutes
  }

  private getMaxConsecutiveErrors(): number {
    const setting = this.dbManager.getSetting('heartbeat_max_consecutive_errors')
    return setting ? parseInt(setting, 10) : this.MAX_CONSECUTIVE_ERRORS
  }

  private sendToRenderer(channel: string, data: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data)
    }
  }
}
