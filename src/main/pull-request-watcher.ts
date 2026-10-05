/**
 * PullRequestWatcher polls the pull requests that tasks opened and wakes the
 * task's agent when something needs its attention: a failed check, a new review
 * comment or requested change from a collaborator, a merge conflict, or a PR
 * that is ready to merge.
 *
 * Each poll is compared with the cursor stored for that PR (see pr_watches in the
 * database), so an event is reported once. Events that arrive while the agent is
 * busy stay queued and go out together when it is idle. Watching stops when the
 * PR is merged or closed. A completed task is paused, not stopped, so reopening
 * it resumes the watch.
 *
 * Rate limits: each PR gets its own backoff after a failed or rate-limited read,
 * and PRs that have been quiet for a long time are polled less often.
 */
import type { DatabaseManager, PullRequestWatchRecord, TaskRecord } from './database'
import {
  PR_WATCH_ENABLED_SETTING,
  PR_WATCH_INTERVAL_MS,
  PR_WATCH_READY_SETTING,
  backoffDelayMs,
  diffPullRequestSnapshot,
  evaluateWakeCondition,
  formatPullRequestWakeMessage,
  isRateLimitError,
  mergeSeenKeys,
  parseWatchablePullRequestUrl,
  pollIntervalMs,
  type PullRequestWatchEvent,
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

/** In-memory pacing for one watch. It resets on restart, and the first poll then runs at once. */
interface WatchSchedule {
  nextPollAt: number
  failures: number
  lastActivityAt: number
}

function watchKey(taskId: string, url: string): string {
  return `${taskId}|${url}`
}

export class PullRequestWatcher {
  private readonly db: DatabaseManager
  private readonly agents: PullRequestWatchAgents
  private readonly source: PullRequestWatchSource
  private readonly intervalMs: number
  private readonly now: () => Date
  private timer: NodeJS.Timeout | null = null
  private stopping = false
  /** The poll now in flight, if any. stop() waits for it. */
  private inFlight: Promise<void> | null = null
  private readonly schedules = new Map<string, WatchSchedule>()

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
    this.stopping = false
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
  }

  /**
   * Stop the timer and wait for any poll in flight. Await it before the
   * database closes, so no write lands on a closed connection.
   */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.inFlight
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
   * Start watching a PR for a task. Automatic detection only calls this for a PR
   * the task created (see createdPullRequestUrlFromTool). Automatic calls never
   * revive a PR that was stopped, so a merged PR that is mentioned again stays
   * unwatched. Explicit calls do revive it.
   */
  register(taskId: string, rawUrl: string, options: { explicit: boolean }): RegisterPullRequestResult {
    const parsed = parseWatchablePullRequestUrl(rawUrl)
    if (!parsed) return { ok: false, error: 'Only GitHub pull request URLs can be watched.' }
    const task = this.db.getTask(taskId)
    if (!task) return { ok: false, error: 'Task not found' }

    const created = this.db.addPullRequestWatch(taskId, parsed.url)
    if (!created && options.explicit) {
      const existing = this.db.getPullRequestWatch(taskId, parsed.url)
      if (existing?.state === 'stopped') {
        this.db.reactivatePullRequestWatch(taskId, parsed.url)
        this.schedules.delete(watchKey(taskId, parsed.url))
      }
    }
    // The next scheduled poll picks up a new watch, so registration never does I/O.
    return { ok: true, url: parsed.url, created, enabled: this.isEnabledForTask(task) }
  }

  /** Check every active watch that is due. Overlapping calls are dropped. */
  tick(): Promise<void> {
    if (this.inFlight || this.stopping) return this.inFlight ?? Promise.resolve()
    this.inFlight = this.pollDueWatches().finally(() => { this.inFlight = null })
    return this.inFlight
  }

  private async pollDueWatches(): Promise<void> {
    for (const watch of this.db.listActivePullRequestWatches()) {
      if (this.stopping) return
      const schedule = this.scheduleFor(watch)
      if (this.now().getTime() < schedule.nextPollAt) continue
      try {
        await this.checkWatch(watch, schedule)
        schedule.failures = 0
      } catch (err) {
        schedule.failures += 1
        const delay = backoffDelayMs(schedule.failures)
        schedule.nextPollAt = this.now().getTime() + delay
        const reason = isRateLimitError(err) ? 'rate limited' : 'failed'
        console.error(`[PRWatch] Check ${reason} for ${watch.url} (task ${watch.task_id}); retrying in ${Math.round(delay / 1000)}s:`, (err as Error).message)
      }
    }
  }

  private scheduleFor(watch: PullRequestWatchRecord): WatchSchedule {
    const key = watchKey(watch.task_id, watch.url)
    let schedule = this.schedules.get(key)
    if (!schedule) {
      const now = this.now().getTime()
      schedule = { nextPollAt: 0, failures: 0, lastActivityAt: now }
      this.schedules.set(key, schedule)
    }
    return schedule
  }

  private async checkWatch(watch: PullRequestWatchRecord, schedule: WatchSchedule): Promise<void> {
    const task = this.db.getTask(watch.task_id)
    if (!task) return

    // A completed task is paused: no requests, and its queue is dropped. Reopening it resumes the watch.
    if (task.status === TaskStatus.Completed) {
      schedule.nextPollAt = this.now().getTime() + PR_WATCH_INTERVAL_MS
      if (watch.pending_events.length > 0) {
        this.db.savePullRequestWatchProgress(task.id, watch.url, {
          seenKeys: watch.seen_keys,
          pendingEvents: [],
          checkedAt: this.now().toISOString()
        })
      }
      return
    }
    // A paused watch keeps its cursor and queued events, and makes no requests.
    if (!this.isEnabledForTask(task)) {
      schedule.nextPollAt = this.now().getTime() + PR_WATCH_INTERVAL_MS
      return
    }

    // Any error here is caught by the caller, which applies the backoff.
    const snapshot = await this.source.fetchPullRequestWatchSnapshot(watch.url)

    const nowMs = this.now().getTime()
    if (snapshot.state !== 'OPEN') {
      this.db.stopPullRequestWatch(watch.task_id, watch.url, snapshot.state === 'MERGED' ? 'merged' : 'closed')
      this.schedules.delete(watchKey(watch.task_id, watch.url))
      return
    }

    const fresh = diffPullRequestSnapshot(snapshot, new Set(watch.seen_keys), {
      notifyReady: this.isReadyNoticeEnabled()
    })
    if (fresh.length > 0) schedule.lastActivityAt = nowMs
    const seenKeys = mergeSeenKeys(watch.seen_keys, fresh)
    const pending: PullRequestWatchEvent[] = [...watch.pending_events, ...fresh]

    const session = this.agents.findSessionByTaskId(task.id)
    const decision = evaluateWakeCondition({
      taskStatus: task.status,
      hasAgent: !!task.agent_id || !!session,
      sessionStatus: session?.session.status ?? null
    })

    // Save the cursor before sending. A crash after the send re-sends at most this one batch,
    // and a crash before it loses nothing, because the events are still in the queue.
    const checkedAt = this.now().toISOString()
    if (decision === 'drop') {
      this.db.savePullRequestWatchProgress(task.id, watch.url, { seenKeys, pendingEvents: [], checkedAt })
    } else {
      this.db.savePullRequestWatchProgress(task.id, watch.url, { seenKeys, pendingEvents: pending, checkedAt })
    }

    if (decision === 'wake' && pending.length > 0) {
      try {
        const message = formatPullRequestWakeMessage(task.id, watch.url, pending, this.now())
        await this.agents.sendByTaskId(task.id, message)
        this.db.savePullRequestWatchProgress(task.id, watch.url, { seenKeys, pendingEvents: [], checkedAt: this.now().toISOString() })
      } catch (err) {
        // The events stay queued, and the next due poll retries the delivery.
        console.error(`[PRWatch] Could not wake the agent for task ${task.id}:`, (err as Error).message)
      }
    }

    schedule.nextPollAt = this.now().getTime() + pollIntervalMs(schedule.lastActivityAt, this.now().getTime())
  }
}
