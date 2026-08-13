import type { DatabaseManager, TaskRecord } from './database'
import type { AgentManager } from './agent-manager'
import { TaskStatus } from '../shared/constants'

/**
 * TaskAutomationScheduler — makes `auto_start_agent` and
 * `auto_complete_without_review` work without a renderer window.
 *
 * ## Why this exists
 *
 * Both flags used to be enforced only by the renderer hook
 * (`use-agent-auto-start.ts`), which reacts to one-shot `task:created` /
 * `task:updated` IPC events. That has three failure modes, and all three were
 * observed on recurring tasks:
 *
 * 1. **No window, no automation.** A recurring instance created while the
 *    window was closed, hidden or reloading never saw its `task:created`
 *    event, and nothing ever retried it — the task sat in `not_started`
 *    for ever.
 * 2. **Missed events are never re-checked.** The renderer had no
 *    reconciliation pass for the flags; only the global "auto-run" scheduler
 *    swept, and that is off by default.
 * 3. **Only one route honoured auto-complete.** `transitionToIdle` checked the
 *    flag, but a task can also reach `ready_for_review` from a coordinator
 *    marking its parent, from an MCP `update_task`, or from the mobile API.
 *    Those routes left the task in review for ever.
 *
 * This scheduler is a *reconciliation loop*, not an event handler: it looks at
 * the durable state in SQLite and repairs it. Missing an event costs latency
 * (up to one tick), never correctness. Callers that want the fast path call
 * {@link runNow} right after they change something.
 */
export class TaskAutomationScheduler {
  private dbManager: DatabaseManager
  private agentManager: AgentManager
  private intervalId: NodeJS.Timeout | null = null
  private readonly CHECK_INTERVAL = 60 * 1000 // 60 seconds

  /** Tasks whose start/complete is in flight — prevents duplicate sessions across overlapping ticks. */
  private inFlight: Set<string> = new Set()
  /** Tasks whose auto-start threw, with the attempt count, so a broken task can't be retried for ever. */
  private failedStarts: Map<string, number> = new Map()
  /**
   * Same idea for completion. A task whose source system refuses the close is
   * put back into review by design — without this counter the sweep would call
   * that failing upstream API again every single tick, for ever.
   */
  private failedCompletions: Map<string, number> = new Map()
  private readonly MAX_START_ATTEMPTS = 3
  private readonly MAX_COMPLETE_ATTEMPTS = 3

  /** Guards against two ticks overlapping when a tick runs longer than the interval. */
  private running = false

  constructor(dbManager: DatabaseManager, agentManager: AgentManager) {
    this.dbManager = dbManager
    this.agentManager = agentManager
  }

  start(): void {
    this.stop() // clear any previous timer to prevent interval leaks
    console.log('[TaskAutomation] Starting scheduler...')

    // Run immediately on startup to repair anything missed while the app was closed
    void this.tick()

    this.intervalId = setInterval(() => {
      void this.tick()
    }, this.CHECK_INTERVAL)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      console.log('[TaskAutomation] Scheduler stopped')
    }
  }

  /**
   * Run one reconciliation pass immediately.
   *
   * Callers use this as the low-latency path after they change task state —
   * a new recurring instance, a status moved to ready_for_review. It is safe
   * to call at any time: the pass is idempotent and re-entrant calls are
   * dropped while a pass is already running.
   */
  async runNow(): Promise<void> {
    await this.tick()
  }

  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.autoStartPendingTasks()
      await this.autoCompleteReviewedTasks()
    } catch (err) {
      console.error('[TaskAutomation] Error during reconciliation pass:', err)
    } finally {
      this.running = false
    }
  }

  // ── Auto-start ──────────────────────────────────────────────

  /**
   * Starts every task that is flagged `auto_start_agent` and is still sitting
   * in `not_started`.
   *
   * Recurring *templates* are excluded: they are schedules, not work. Their
   * instances carry the flag forward and are what actually runs.
   */
  private async autoStartPendingTasks(): Promise<void> {
    const tasks = this.getAutoStartCandidates()
    if (tasks.length === 0) return

    console.log(`[TaskAutomation] Found ${tasks.length} task(s) to auto-start`)

    // Sequential: startTask sets up worktrees and spawns a CLI agent. Firing
    // them all at once on a catch-up sweep would stampede the machine.
    for (const task of tasks) {
      if (this.inFlight.has(task.id)) continue
      if (this.agentManager.hasActiveSessionForTask(task.id)) continue

      this.inFlight.add(task.id)
      try {
        const result = await this.agentManager.startTask(task.id)
        console.log(`[TaskAutomation] Auto-started "${task.title}" (${task.id}): ${result.action}`)
        this.failedStarts.delete(task.id)
      } catch (err) {
        const attempts = (this.failedStarts.get(task.id) ?? 0) + 1
        this.failedStarts.set(task.id, attempts)
        console.error(
          `[TaskAutomation] Failed to auto-start task ${task.id} (attempt ${attempts}/${this.MAX_START_ATTEMPTS}):`,
          err
        )
      } finally {
        this.inFlight.delete(task.id)
      }
    }
  }

  /**
   * Tasks flagged for auto-start that are still waiting to run, plus the next
   * subtask of any such task.
   *
   * The subtask half matters because a coordinator can create children and
   * then stop. Its own status is then agent_working or ready_for_review, so
   * neither it nor its children match the flag query — and a subtask never
   * carries `auto_start_agent` itself, because `/create_subtask` does not set
   * it. Without this the children sit in not_started for ever.
   */
  private getAutoStartCandidates(): TaskRecord[] {
    const now = new Date().toISOString()
    // Subtasks are driven through their parent, never directly, so that they
    // keep running one at a time in sort_order. Picking a flagged subtask up
    // here would start the whole set at once.
    const flagged = this.dbManager.db.prepare(`
      SELECT id, status FROM tasks
      WHERE auto_start_agent = 1
        AND parent_task_id IS NULL
        AND NOT (is_recurring = 1 AND recurrence_parent_id IS NULL)
        AND (snoozed_until IS NULL OR snoozed_until <= ?)
      ORDER BY created_at ASC
    `).all(now) as { id: string; status: string }[]

    const candidateIds: string[] = []
    for (const row of flagged) {
      // A parent with children hands over to them — starting it again would
      // run the coordinator a second time.
      const nextSubtaskId = this.getNextStartableSubtaskId(row.id)
      if (nextSubtaskId) {
        candidateIds.push(nextSubtaskId)
        continue
      }
      if (row.status === TaskStatus.NotStarted && !this.hasSubtasks(row.id)) {
        candidateIds.push(row.id)
      }
    }

    return candidateIds
      .filter((id) => (this.failedStarts.get(id) ?? 0) < this.MAX_START_ATTEMPTS)
      .map((id) => this.dbManager.getTask(id))
      .filter((task): task is TaskRecord => !!task)
  }

  private hasSubtasks(taskId: string): boolean {
    return this.dbManager.getSubtasks(taskId).length > 0
  }

  /** Subtasks that still have work left before their parent can finish. */
  private hasPendingSubtasks(taskId: string): boolean {
    return this.dbManager.getSubtasks(taskId).some(
      (subtask) =>
        subtask.status !== TaskStatus.Completed && subtask.status !== TaskStatus.ReadyForReview
    )
  }

  /**
   * The one subtask that should run next, or null.
   *
   * Subtasks run strictly in `sort_order`, one at a time. Only a genuinely
   * running state blocks the next one.
   *
   * The renderer also blocked on `ready_for_review`, which deadlocks an
   * unattended chain: a child that finishes stops there (a subtask does not
   * carry `auto_complete_without_review`), so nothing would ever start the
   * child after it. A child in review has finished its agent run, and
   * notifyParentOfSubtaskCompletion already counts that state as terminal.
   */
  private getNextStartableSubtaskId(parentId: string): string | null {
    const subtasks = this.dbManager.getSubtasks(parentId)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    if (subtasks.length === 0) return null

    const active = subtasks.some(
      (subtask) =>
        subtask.status === TaskStatus.AgentWorking ||
        subtask.status === TaskStatus.Triaging ||
        subtask.status === TaskStatus.AgentLearning
    )
    if (active) return null

    const next = subtasks.find((subtask) => subtask.status === TaskStatus.NotStarted && !!subtask.agent_id)
    return next?.id ?? null
  }

  // ── Auto-complete ───────────────────────────────────────────

  /**
   * Completes every task that is flagged `auto_complete_without_review` and
   * has been left in `ready_for_review`.
   *
   * A task with a live session is skipped — its own `transitionToIdle` owns
   * the decision, and completing underneath a running agent would cut its
   * work short.
   */
  private async autoCompleteReviewedTasks(): Promise<void> {
    const rows = this.dbManager.db.prepare(`
      SELECT id FROM tasks
      WHERE auto_complete_without_review = 1
        AND status = ?
        AND NOT (is_recurring = 1 AND recurrence_parent_id IS NULL)
      ORDER BY updated_at ASC
    `).all(TaskStatus.ReadyForReview) as { id: string }[]

    const candidates = rows.filter(
      (row) => (this.failedCompletions.get(row.id) ?? 0) < this.MAX_COMPLETE_ATTEMPTS
    )
    if (candidates.length === 0) return

    console.log(`[TaskAutomation] Found ${candidates.length} task(s) to auto-complete`)

    for (const row of candidates) {
      if (this.inFlight.has(row.id)) continue
      if (this.agentManager.hasActiveSessionForTask(row.id)) {
        console.log(`[TaskAutomation] Skipping auto-complete of ${row.id} — agent session still active`)
        continue
      }
      // Waiting for children is not a failure, so it must not burn an attempt.
      // AgentManager refuses this too; skipping here keeps the retry counter
      // for genuine refusals only.
      if (this.hasPendingSubtasks(row.id)) {
        console.log(`[TaskAutomation] Skipping auto-complete of ${row.id} — subtasks have not finished`)
        continue
      }

      this.inFlight.add(row.id)
      try {
        const completed = await this.agentManager.completeTaskWithoutReview(row.id)
        if (completed) {
          this.failedCompletions.delete(row.id)
          console.log(`[TaskAutomation] Auto-completed task ${row.id}`)
        } else {
          const attempts = (this.failedCompletions.get(row.id) ?? 0) + 1
          this.failedCompletions.set(row.id, attempts)
          console.log(
            `[TaskAutomation] Task ${row.id} refused completion upstream — left for review ` +
            `(attempt ${attempts}/${this.MAX_COMPLETE_ATTEMPTS})`
          )
        }
      } catch (err) {
        const attempts = (this.failedCompletions.get(row.id) ?? 0) + 1
        this.failedCompletions.set(row.id, attempts)
        console.error(`[TaskAutomation] Failed to auto-complete task ${row.id}:`, err)
      } finally {
        this.inFlight.delete(row.id)
      }
    }
  }
}
