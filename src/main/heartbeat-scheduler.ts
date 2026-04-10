import { BrowserWindow, Notification } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import type { DatabaseManager, TaskRecord } from './database'
import type { AgentManager } from './agent-manager'
import { HeartbeatStatus, HEARTBEAT_OK_TOKEN, HEARTBEAT_INFO_TOKEN, HEARTBEAT_DEFAULTS } from '../shared/constants'

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

    this.sendToRenderer('task:updated', {
      taskId,
      updates: {
        heartbeat_enabled: true,
        heartbeat_interval_minutes: interval,
        heartbeat_next_check_at: nextCheck.toISOString()
      }
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

    this.sendToRenderer('task:updated', {
      taskId,
      updates: {
        heartbeat_enabled: false,
        heartbeat_next_check_at: null
      }
    })

    console.log(`[HeartbeatScheduler] Disabled heartbeat for task ${taskId}`)
  }

  /**
   * Manually trigger a heartbeat check for a specific task.
   * Skips pre-flight checks — always sends to the agent since the user explicitly requested it.
   * Returns a status string so the UI can show feedback.
   */
  async runNow(taskId: string): Promise<'sent' | 'no_file' | 'no_agent' | 'error'> {
    const task = this.dbManager.getTask(taskId)
    if (!task) {
      console.warn(`[HeartbeatScheduler] runNow: task ${taskId} not found`)
      return 'error'
    }

    const heartbeatContent = this.readHeartbeatFile(taskId)
    if (!heartbeatContent) {
      return 'no_file'
    }

    const agentId = this.resolveAgentId(task)
    if (!agentId) {
      return 'no_agent'
    }

    try {
      // Phase 1: Send check to mastermind (skips preflight since user requested it)
      const checkPrompt = this.buildHeartbeatPrompt(task, heartbeatContent)
      const mastermindSessionId = await this.agentManager.sendHeartbeatViaMastermind(agentId, task.id, checkPrompt)

      // Phase 2: Wait for result and forward — run in background so IPC returns immediately
      this.processRunNowResult(mastermindSessionId, task, agentId).catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[HeartbeatScheduler] runNow background error for task ${taskId}:`, message)
        this.logResult(taskId, HeartbeatStatus.Error, message)
      })

      return 'sent'
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[HeartbeatScheduler] runNow error for task ${taskId}:`, message)
      this.logResult(taskId, HeartbeatStatus.Error, message)
      return 'error'
    }
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

  /**
   * Write or update the heartbeat.md file for a task.
   * Creates the file if it doesn't exist. Ensures the workspace directory exists.
   */
  writeHeartbeatFile(taskId: string, content: string): void {
    const filePath = this.getHeartbeatFilePath(taskId)
    const dir = dirname(filePath)
    const previousContent = this.readHeartbeatFile(taskId)
    const normalizedContent = content.trim()
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(filePath, content, 'utf-8')
    console.log(`[HeartbeatScheduler] Wrote heartbeat.md for task ${taskId} (${content.length} chars)`)

    if ((previousContent ?? '') !== normalizedContent) {
      const task = this.dbManager.getTask(taskId)
      const updates: Partial<TaskRecord> = {
        heartbeat_last_check_at: null
      }

      if (task?.heartbeat_enabled) {
        updates.heartbeat_next_check_at = new Date().toISOString()
      }

      this.dbManager.updateTask(taskId, updates)
      console.log(`[HeartbeatScheduler] Reset heartbeat baseline for task ${taskId} after instructions changed`)
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

        // Skip if task has a live agent session (user is actively working)
        if (this.agentManager.hasActiveSessionForTask(task.id)) {
          console.log(`[HeartbeatScheduler] Skipping task ${task.id} — active agent session in progress`)
          continue
        }

        // Skip completed tasks and disable their heartbeat
        if (task.status === 'completed') {
          console.log(`[HeartbeatScheduler] Task ${task.id} is completed, disabling heartbeat`)
          this.disableHeartbeat(task.id)
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
   * Two-phase approach to avoid polluting task agent context:
   * 1. Pre-flight: cheap `gh api` checks (no LLM)
   * 2. If changes detected → mastermind session evaluates findings
   * 3. If mastermind says action needed → spawn task agent with specific instructions
   * 4. If HEARTBEAT_OK → task agent is never touched
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

      // Phase 1: Pre-flight checks (cheap, no LLM)
      const preflightResult = await this.runPreflightChecks(heartbeatContent, task)
      if (preflightResult === 'no_changes') {
        console.log(`[HeartbeatScheduler] Pre-flight: no changes for task "${task.title}", skipping LLM`)
        this.logResult(task.id, HeartbeatStatus.Ok, 'Pre-flight: no changes detected (LLM skipped)')
        this.advanceNextCheck(task, true)
        return
      }

      const agentId = this.resolveAgentId(task)
      if (!agentId) {
        console.warn(`[HeartbeatScheduler] No agent available for task ${task.id}, skipping`)
        this.logResult(task.id, HeartbeatStatus.Error, 'No agent available for heartbeat check')
        this.advanceNextCheck(task)
        return
      }

      // Phase 2: Send check to mastermind session (doesn't pollute task context)
      const checkPrompt = this.buildHeartbeatPrompt(task, heartbeatContent)
      const mastermindSessionId = await this.agentManager.sendHeartbeatViaMastermind(agentId, task.id, checkPrompt)
      const mastermindResult = await this.waitForSessionResult(mastermindSessionId, task.id)

      // Phase 3: Evaluate mastermind result
      const classification = this.classifyMastermindResult(mastermindResult)

      if (classification === 'ok') {
        console.log(`[HeartbeatScheduler] ${HEARTBEAT_OK_TOKEN} for task "${task.title}" (mastermind check)`)
        this.logResult(task.id, HeartbeatStatus.Ok, this.extractSummary(mastermindResult, HeartbeatStatus.Ok), mastermindSessionId)
        this.advanceNextCheck(task, true)
      } else if (classification === 'info') {
        console.log(`[HeartbeatScheduler] Info for task "${task.title}": ${mastermindResult.substring(0, 100)}`)
        this.logResult(task.id, HeartbeatStatus.Info, this.extractSummary(mastermindResult, HeartbeatStatus.Info), mastermindSessionId)
        this.advanceNextCheck(task, true) // no action needed, treat like OK for interval
      } else {
        console.log(`[HeartbeatScheduler] Action needed for task "${task.title}", forwarding to task agent`)
        const actionPrompt = this.buildActionPrompt(task, mastermindResult)
        const taskSessionId = await this.agentManager.startHeartbeatSession(agentId, task.id, actionPrompt)
        const taskResult = await this.waitForSessionResult(taskSessionId, task.id, task.id)
        this.handleResult(task, taskSessionId, taskResult)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[HeartbeatScheduler] Heartbeat error for task ${task.id}:`, message)
      this.logResult(task.id, HeartbeatStatus.Error, message)

      this.checkConsecutiveErrors(task.id)
      this.advanceNextCheck(task)
    } finally {
      this.inProgress.delete(task.id)
      this.agentManager.cleanupHeartbeatSession(task.id)
    }
  }

  /**
   * Background processing for runNow — waits for mastermind result and forwards to task agent if needed.
   */
  private async processRunNowResult(mastermindSessionId: string, task: TaskRecord, agentId: string): Promise<void> {
    try {
      const mastermindResult = await this.waitForSessionResult(mastermindSessionId, task.id)
      const classification = this.classifyMastermindResult(mastermindResult)

      if (classification === 'action') {
        console.log(`[HeartbeatScheduler] runNow: mastermind found action needed, forwarding to task agent`)
        const actionPrompt = this.buildActionPrompt(task, mastermindResult)
        await this.agentManager.startHeartbeatSession(agentId, task.id, actionPrompt)
      } else {
        const logStatus = classification === 'ok' ? HeartbeatStatus.Ok : HeartbeatStatus.Info
        console.log(`[HeartbeatScheduler] runNow: ${classification} for task "${task.title}"`)
        this.logResult(task.id, logStatus, this.extractSummary(mastermindResult, logStatus), mastermindSessionId)
      }
    } finally {
      this.agentManager.cleanupHeartbeatSession(task.id)
    }
  }

  /**
   * Build the prompt for the mastermind heartbeat check.
   * Mastermind evaluates the status — it doesn't make changes.
   */
  private buildHeartbeatPrompt(task: TaskRecord, heartbeatContent: string): string {
    const globalInstructions = this.dbManager.getSetting('heartbeat_global_instructions') || ''
    const lastCheck = task.heartbeat_last_check_at
    const hasGitHubPullLink = this.extractGitHubUrls(heartbeatContent).some(url => url.type === 'pull')

    let prompt = `Heartbeat check for task: "${task.title}"\n\n`

    if (lastCheck) {
      prompt += `IMPORTANT: Only consider events after ${lastCheck}. Ignore anything older — it has already been handled.\n\n`
    }

    if (hasGitHubPullLink || this.requiresCurrentStateChecks(heartbeatContent)) {
      prompt += 'For checks about current state (for example merge conflicts, unresolved requested changes, or the latest CI status), inspect the current state even if the problem started before the last check.\n\n'
    }

    if (globalInstructions.trim()) {
      prompt += `${globalInstructions.trim()}\n\n`
    }

    prompt += `${heartbeatContent}\n\n`
    prompt += `Run the checks above. Reply with one of:\n`
    prompt += `- "${HEARTBEAT_OK_TOKEN}" — nothing new since last check\n`
    prompt += `- "${HEARTBEAT_INFO_TOKEN}: <summary>" — something new but no action needed (e.g. approval, positive comment)\n`
    prompt += `- Otherwise describe specific new findings that need action. Do NOT take action yourself — just report.`

    return prompt
  }

  /**
   * Build the prompt for the task agent when mastermind found something.
   * This goes to the task's own session so the agent can act on findings.
   */
  private buildActionPrompt(task: TaskRecord, mastermindFindings: string): string {
    return `[Heartbeat] The following was detected during a periodic check of task "${task.title}":\n\n${mastermindFindings}\n\nPlease address the findings above. When done, end your message with "${HEARTBEAT_OK_TOKEN}".`
  }

  /**
   * Classify the mastermind's response into one of three categories.
   */
  private classifyMastermindResult(result: string): 'ok' | 'info' | 'action' {
    if (result.includes(HEARTBEAT_OK_TOKEN)) return 'ok'
    if (result.includes(HEARTBEAT_INFO_TOKEN)) return 'info'
    return 'action'
  }

  /**
   * Wait for a heartbeat session to complete and extract the result text.
   * Polls the agent session status until it transitions to idle.
   */
  private waitForSessionResult(sessionId: string, taskId: string, fallbackTaskId?: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const INACTIVITY_TIMEOUT_MS = 5 * 60_000 // 5 min since last sign of life
      const POLL_MS = 3_000 // check every 3s

      // Track the last time the session showed any activity (working status,
      // new message, etc.). The timeout only fires if there has been NO
      // activity for the full INACTIVITY_TIMEOUT_MS window. This handles
      // long multi-step coding sessions where the agent flickers between
      // 'working' and 'idle' across tool calls.
      let lastActivityAt = Date.now()
      // Track the current session ID — may change if the adapter re-keys it
      let currentSessionId = sessionId
      // Use the provided fallbackTaskId for re-keying lookup, defaulting to
      // the heartbeat session's taskId. This ensures Phase 3 (task agent)
      // looks up the correct session instead of the mastermind session.
      const lookupTaskId = fallbackTaskId || `heartbeat-${taskId}`

      const timer = setInterval(() => {
        // Try to find the session by ID first
        let session = this.agentManager.getSession(currentSessionId)

        // If not found, the session ID may have been re-keyed by pollSingleSession
        // (adapter provides real ID, old temp ID is deleted from sessions map).
        // Fall back to finding the session by its stable taskId.
        if (!session) {
          const found = this.agentManager.findSessionByTaskId(lookupTaskId)
          if (found) {
            console.log(`[HeartbeatScheduler] Session ID re-keyed: ${currentSessionId} → ${found.sessionId}`)
            currentSessionId = found.sessionId
            session = found.session
          }
        }

        // Session is actively working — mark activity and keep waiting
        if (session?.status === 'working') {
          lastActivityAt = Date.now()
          return
        }

        if (session?.status === 'error') {
          clearInterval(timer)
          reject(new Error(`Heartbeat session ${currentSessionId} ended with error`))
          return
        }

        if (!session || session.status === 'idle') {
          // Guard against race condition: sendMessage fires doSendAdapterMessage
          // as fire-and-forget, so the adapter may report IDLE before the prompt
          // is even sent. Only treat idle as "done" if the session has actually
          // produced an assistant response (lastAssistantText is set during polling).
          const lastMessage = this.agentManager.getLastAssistantMessage(currentSessionId)
          if (lastMessage) {
            clearInterval(timer)
            resolve(lastMessage)
            return
          }

          const inactiveMs = Date.now() - lastActivityAt
          if (inactiveMs >= INACTIVITY_TIMEOUT_MS) {
            clearInterval(timer)
            reject(new Error(`Heartbeat session ${currentSessionId} timed out after ${Math.round(inactiveMs / 60_000)} minutes of inactivity`))
          }
          // Otherwise keep waiting — agent may not have processed the prompt yet
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
      this.logResult(task.id, HeartbeatStatus.Ok, this.extractSummary(result, HeartbeatStatus.Ok), sessionId)
      this.advanceNextCheck(task, true) // adaptive: may increase interval
    } else {
      console.log(`[HeartbeatScheduler] Attention needed for task "${task.title}": ${result.substring(0, 100)}`)
      this.logResult(task.id, HeartbeatStatus.AttentionNeeded, this.extractSummary(result, HeartbeatStatus.AttentionNeeded), sessionId)
      this.notifyAttentionNeeded(task, result)
      this.advanceNextCheck(task, false) // reset to base interval
    }
  }

  /**
   * Build a compact check summary for heartbeat logs.
   * Strips control tokens so UI can show meaningful check context.
   */
  private extractSummary(result: string, status: HeartbeatStatus): string {
    const infoTokenPattern = new RegExp(`^${HEARTBEAT_INFO_TOKEN}\\s*:\\s*`, 'i')
    const normalized = result
      .replace(HEARTBEAT_OK_TOKEN, '')
      .replace(infoTokenPattern, '')
      .replace(/\s+/g, ' ')
      .trim()

    if (normalized.length > 0) {
      return normalized.substring(0, 500)
    }

    if (status === HeartbeatStatus.Ok) {
      return 'All checks passed (no new updates)'
    }

    if (status === HeartbeatStatus.Info) {
      return 'Checked: update found, but no action needed'
    }

    return 'Checked: action needed'
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

    // Phase 1: Always check CI status for PRs (cheap, catches deployment failures)
    // This runs even when current-state checks are needed, so CI failures are never missed.
    const pullUrls = githubUrls.filter(u => u.type === 'pull')
    for (const url of pullUrls) {
      try {
        const { stdout: prJson } = await execFileAsync('gh', [
          'api',
          `repos/${url.owner}/${url.repo}/pulls/${url.number}`,
          '--jq', '.head.sha'
        ], { timeout: 15_000 })

        const headSha = prJson.trim()
        if (headSha) {
          const hasFailed = await this.hasFailedCheckRuns(url.owner, url.repo, headSha)
          if (hasFailed) {
            console.log(`[HeartbeatScheduler] Pre-flight: CI failure detected for ${url.owner}/${url.repo}#${url.number}`)
            return 'changes_detected'
          }
        }
      } catch {
        // CI check failed — fall through to LLM
        return 'inconclusive'
      }
    }

    // Phase 2: If heartbeat needs current-state checks that pre-flight cannot
    // reliably interpret (for example unresolved requested changes), delegate to
    // the LLM. Conflict state, CI status, comments, and reviews are covered by
    // the hard checks above/below.
    if (this.requiresLlmCurrentStateChecks(heartbeatContent)) {
      return 'inconclusive'
    }

    // Phase 3: Check for new activity since last check (comments, reviews, merge conflicts)
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
   * Detect whether the heartbeat instructions require checking the current state,
   * not just new activity since the last run.
   */
  private requiresCurrentStateChecks(heartbeatContent: string): boolean {
    return /(requested changes|request changes|merge conflict|conflict|ci\b|pipeline|status check|check run)/i.test(heartbeatContent)
  }

  private requiresLlmCurrentStateChecks(heartbeatContent: string): boolean {
    return /(requested changes|request changes)/i.test(heartbeatContent)
  }

  private hasMergeConflicts(prState: { mergeable: boolean | null; mergeable_state?: string | null }): boolean {
    return prState.mergeable_state === 'dirty'
  }

  /**
   * Check if a commit has any failed CI check-runs or commit statuses.
   * Uses the combined status endpoint which aggregates both check-runs and commit statuses.
   */
  private async hasFailedCheckRuns(owner: string, repo: string, sha: string): Promise<boolean> {
    try {
      // Check check-runs (GitHub Actions, etc.)
      const { stdout: checkRunsJson } = await execFileAsync('gh', [
        'api',
        `repos/${owner}/${repo}/commits/${sha}/check-runs`,
        '--jq', '[.check_runs[] | select(.status == "completed" and (.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "cancelled"))] | length'
      ], { timeout: 15_000 })

      const failedCheckRuns = parseInt(checkRunsJson.trim(), 10)
      if (failedCheckRuns > 0) return true

      // Check commit statuses (Vercel, external CI, etc.)
      const { stdout: statusJson } = await execFileAsync('gh', [
        'api',
        `repos/${owner}/${repo}/commits/${sha}/status`,
        '--jq', '[.statuses[] | select(.state == "failure" or .state == "error")] | length'
      ], { timeout: 15_000 })

      const failedStatuses = parseInt(statusJson.trim(), 10)
      return failedStatuses > 0
    } catch {
      // If we can't determine CI status, signal inconclusive (caller will throw → LLM fallback)
      return false
    }
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
        if (newIssueComments > 0) return true

        // Check CI/check-run status — detect failed checks
        const { stdout: checkRunsJson } = await execFileAsync('gh', [
          'api',
          `repos/${url.owner}/${url.repo}/pulls/${url.number}`,
          '--jq', '{ mergeable: .mergeable, mergeable_state: .mergeable_state, head_sha: .head.sha }'
        ], { timeout: 15_000 })

        const prState = JSON.parse(checkRunsJson.trim()) as { mergeable: boolean | null; mergeable_state?: string | null; head_sha?: string }

        // Check for merge conflicts
        if (this.hasMergeConflicts(prState)) return true

        // Check for failed CI check-runs on the HEAD commit
        if (prState.head_sha) {
          const hasFailedChecks = await this.hasFailedCheckRuns(url.owner, url.repo, prState.head_sha)
          if (hasFailedChecks) return true
        }

        return false
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
