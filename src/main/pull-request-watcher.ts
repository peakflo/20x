/**
 * PullRequestWatcher polls the pull requests that tasks opened and wakes the
 * task's agent when something needs its attention: a failed check, a new review
 * comment or requested change, a merge conflict, or a PR that is ready to merge.
 *
 * Each poll is compared with the cursor stored for that PR (see pr_watches in the
 * database), so an event is reported once. Events that arrive while the agent is
 * busy stay queued and are delivered together in one message when it is idle.
 * Watching stops when the PR is merged or closed, or when the task completes.
 */
import type { DatabaseManager, PullRequestWatchRecord, TaskRecord } from './database'
import {
  PR_WATCH_ENABLED_SETTING,
  PR_WATCH_INTERVAL_MS,
  PR_WATCH_READY_SETTING,
  diffPullRequestSnapshot,
  evaluateWakeCondition,
  formatPullRequestWakeMessage,
  mergeSeenKeys,
  parseWatchablePullRequestUrl,
  type PullRequestWatchSnapshot
} from './pull-request-watch'
import { TaskStatus } from '../shared/constants'

/** The slice of AgentManager the watcher needs. */
export interface PullRequestWatchAgents {
  findSessionByTaskId(taskId: string): { sessionId: string; session: { status: string } } | undefined
  sendByTaskId(taskId: string, message: string): Promise<unknown>
}

/** Reads PR state. GitHubManager implements this. */
export interface PullRequestWatchSource {
  fetchPullRequestWatchSnapshot(url: string): Promise<PullRequestWatchSnapshot>
}

export interface PullRequestWatcherOptions {
  intervalMs?: number
  now?: () => Date
}

export type RegisterPullRequestResult =
  | { ok: true; url: string; created: boolean; enabled: boolean }
  | { ok: false; error: string }

/**
 * A task's own switch wins when it is set. A null switch follows the global one.
 * Pure, so the rule is testable without a database.
 */
export function resolvePullRequestWatchEnabled(taskSwitch: boolean | null | undefined, globalEnabled: boolean): boolean {
  return taskSwitch ?? globalEnabled
}

export class PullRequestWatcher {
  private readonly db: DatabaseManager
  private readonly agents: PullRequestWatchAgents
  private readonly source: PullRequestWatchSource
  private readonly intervalMs: number
  private readonly now: () => Date
  private timer: NodeJS.Timeout | null = null
  private polling = false

  constructor(
    db: DatabaseManager,
    agents: PullRequestWatchAgents,
    source: PullRequestWatchSource,
    options: PullRequestWatcherOptions = {}
  ) {
    this.db = db
    this.agents = agents
    this.source = source
    this.intervalMs = options.intervalMs ?? PR_WATCH_INTERVAL_MS
    this.now = options.now ?? (() => new Date())
  }

  start(): void {
    this.stop()
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** The global switch. Absent means enabled. */
  isGloballyEnabled(): boolean {
    return this.db.getSetting(PR_WATCH_ENABLED_SETTING) !== 'false'
  }

  isReadyNoticeEnabled(): boolean {
    return this.db.getSetting(PR_WATCH_READY_SETTING) !== 'false'
  }

  isEnabledForTask(task: Pick<TaskRecord, 'pr_watch_enabled'>): boolean {
    return resolvePullRequestWatchEnabled(task.pr_watch_enabled ?? null, this.isGloballyEnabled())
  }

  /**
   * Start watching a PR for a task. Called when a PR is detected in a tool
   * result (automatic) and by the watch_pull_request tool (explicit). Automatic
   * calls never revive a PR that was stopped, so a merged PR that is mentioned
   * again stays unwatched. Explicit calls do revive it.
   */
  register(taskId: string, rawUrl: string, options: { explicit: boolean }): RegisterPullRequestResult {
    const parsed = parseWatchablePullRequestUrl(rawUrl)
    if (!parsed) return { ok: false, error: 'Only GitHub pull request URLs can be watched.' }
    const task = this.db.getTask(taskId)
    if (!task) return { ok: false, error: 'Task not found' }

    const created = this.db.addPullRequestWatch(taskId, parsed.url)
    if (!created && options.explicit) {
      const existing = this.db.getPullRequestWatch(taskId, parsed.url)
      if (existing?.state === 'stopped') this.db.reactivatePullRequestWatch(taskId, parsed.url)
    }
    // The next scheduled poll picks up a new watch, so registration never does I/O.
    return { ok: true, url: parsed.url, created, enabled: this.isEnabledForTask(task) }
  }

  /** Check every active watch once. Overlapping calls are dropped. */
  async tick(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      for (const watch of this.db.listActivePullRequestWatches()) {
        try {
          await this.checkWatch(watch)
        } catch (err) {
          console.error(`[PRWatch] Check failed for ${watch.url} (task ${watch.task_id}):`, (err as Error).message)
        }
      }
    } finally {
      this.polling = false
    }
  }

  private async checkWatch(watch: PullRequestWatchRecord): Promise<void> {
    const task = this.db.getTask(watch.task_id)
    if (!task) return

    if (task.status === TaskStatus.Completed) {
      this.db.stopPullRequestWatch(watch.task_id, watch.url, 'task_completed')
      return
    }
    // A paused watch keeps its cursor and queued events, and makes no requests.
    if (!this.isEnabledForTask(task)) return

    let snapshot: PullRequestWatchSnapshot
    try {
      snapshot = await this.source.fetchPullRequestWatchSnapshot(watch.url)
    } catch (err) {
      console.warn(`[PRWatch] Could not read ${watch.url}: ${(err as Error).message}`)
      return
    }

    if (snapshot.state !== 'OPEN') {
      this.db.stopPullRequestWatch(watch.task_id, watch.url, snapshot.state === 'MERGED' ? 'merged' : 'closed')
      return
    }

    const fresh = diffPullRequestSnapshot(snapshot, new Set(watch.seen_keys), {
      notifyReady: this.isReadyNoticeEnabled()
    })
    const seenKeys = mergeSeenKeys(watch.seen_keys, fresh)
    let pending = [...watch.pending_events, ...fresh]

    const session = this.agents.findSessionByTaskId(task.id)
    const decision = evaluateWakeCondition({
      taskStatus: task.status,
      hasAgent: !!task.agent_id || !!session,
      sessionStatus: session?.session.status ?? null
    })

    if (decision === 'drop') {
      pending = []
    } else if (decision === 'wake' && pending.length > 0) {
      try {
        const message = formatPullRequestWakeMessage(task.id, watch.url, pending, this.now())
        await this.agents.sendByTaskId(task.id, message)
        pending = []
      } catch (err) {
        // Keep the events queued. The next poll retries the same delivery.
        console.error(`[PRWatch] Could not wake the agent for task ${task.id}:`, (err as Error).message)
      }
    }

    this.db.savePullRequestWatchProgress(task.id, watch.url, {
      seenKeys,
      pendingEvents: pending,
      checkedAt: this.now().toISOString()
    })
  }
}
