/**
 * Usage-limit recovery: persists "this task stopped on a subscription limit"
 * and sends a continuation once the limit window resets.
 *
 * Design:
 * - One recovery row per task (`usage_limit_recoveries`), derived purely from
 *   persisted state, so pending continuations survive app restarts.
 * - A sweep runs every {@link SWEEP_INTERVAL_MS}. A recovery fires when it is
 *   `waiting`, `autoResume` is on, its `resetAt` is known and has passed
 *   (plus a small grace period for the provider's window to roll over).
 * - Firing first marks the row `resumed` (so a crash can never send twice),
 *   then dispatches the continuation through the injected `resume` callback.
 * - Guards: the task must still exist, not be completed, and still be assigned
 *   to the same agent; the user's own messages supersede the recovery.
 * - Loop guard: a continuation that hits the limit again re-arms only while
 *   fewer than {@link MAX_CONSECUTIVE_AUTO_RESUMES} happened in a row, and a
 *   reset time that is not after the stop is treated as unknown.
 */

import type Database from 'better-sqlite3'
import type { ProviderUsageLimits, UsageProvider } from '../../shared/usage'
import { isUsageProvider } from '../../shared/usage'
import type { UsageLimitRecovery, UsageLimitRecoveryStatus } from '../../shared/usage-limit-recovery'
import { exhaustedWindowsResetAt } from './usage-normalize'

export const SWEEP_INTERVAL_MS = 30 * 1000
/** Wait this long after the reported reset before continuing. */
export const RESET_GRACE_MS = 60 * 1000
export const MAX_CONSECUTIVE_AUTO_RESUMES = 3
/** A new stop within this window of an automatic continuation counts as "hit again". */
const REPEAT_WINDOW_MS = 30 * 60 * 1000

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS usage_limit_recoveries (
    task_id TEXT PRIMARY KEY,
    agent_id TEXT,
    provider TEXT,
    session_id TEXT,
    stopped_at INTEGER NOT NULL,
    reset_at TEXT,
    auto_resume INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    message TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    resumed_at INTEGER,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_usage_limit_recoveries_status ON usage_limit_recoveries(status);
`

interface RecoveryRow {
  task_id: string
  agent_id: string | null
  provider: string | null
  session_id: string | null
  stopped_at: number
  reset_at: string | null
  auto_resume: number
  status: string
  message: string | null
  attempts: number
  resumed_at: number | null
  error: string | null
}

function fromRow(row: RecoveryRow): UsageLimitRecovery {
  return {
    taskId: row.task_id,
    agentId: row.agent_id,
    provider: isUsageProvider(row.provider) ? row.provider : null,
    sessionId: row.session_id,
    stoppedAt: row.stopped_at,
    resetAt: row.reset_at,
    autoResume: row.auto_resume === 1,
    status: row.status as UsageLimitRecoveryStatus,
    message: row.message,
    attempts: row.attempts,
    resumedAt: row.resumed_at,
    error: row.error
  }
}

export class UsageLimitRecoveryStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(SCHEMA_SQL)
  }

  get(taskId: string): UsageLimitRecovery | null {
    const row = this.db.prepare('SELECT * FROM usage_limit_recoveries WHERE task_id = ?').get(taskId) as RecoveryRow | undefined
    return row ? fromRow(row) : null
  }

  listWaiting(): UsageLimitRecovery[] {
    return (this.db.prepare("SELECT * FROM usage_limit_recoveries WHERE status = 'waiting' ORDER BY stopped_at").all() as RecoveryRow[]).map(fromRow)
  }

  save(recovery: UsageLimitRecovery): void {
    this.db.prepare(`
      INSERT INTO usage_limit_recoveries (task_id, agent_id, provider, session_id, stopped_at, reset_at, auto_resume, status, message, attempts, resumed_at, error)
      VALUES (@taskId, @agentId, @provider, @sessionId, @stoppedAt, @resetAt, @autoResume, @status, @message, @attempts, @resumedAt, @error)
      ON CONFLICT(task_id) DO UPDATE SET
        agent_id = excluded.agent_id, provider = excluded.provider, session_id = excluded.session_id,
        stopped_at = excluded.stopped_at, reset_at = excluded.reset_at, auto_resume = excluded.auto_resume,
        status = excluded.status, message = excluded.message, attempts = excluded.attempts,
        resumed_at = excluded.resumed_at, error = excluded.error
    `).run({ ...recovery, autoResume: recovery.autoResume ? 1 : 0 })
  }

  delete(taskId: string): void {
    this.db.prepare('DELETE FROM usage_limit_recoveries WHERE task_id = ?').run(taskId)
  }
}

export interface UsageLimitStopInput {
  taskId: string
  agentId: string | null
  provider: UsageProvider | null
  sessionId: string | null
  resetAt: string | null
  message: string | null
}

export interface RecoveryTaskState {
  exists: boolean
  completed: boolean
  agentId: string | null
  /** An agent session for the task is currently working. */
  busy: boolean
}

export interface UsageLimitRecoveryDeps {
  store: UsageLimitRecoveryStore
  /** Whether new recoveries continue automatically (user setting). */
  autoResumeEnabled: () => boolean
  getTaskState: (taskId: string) => RecoveryTaskState
  /** Sends the continuation to the task's agent session. */
  resume: (recovery: UsageLimitRecovery) => Promise<void>
  /** Broadcast a changed recovery to the UI. */
  emit: (recovery: UsageLimitRecovery) => void
  now?: () => number
}

export class UsageLimitRecoveryScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private sweeping = false
  private readonly now: () => number

  constructor(private readonly deps: UsageLimitRecoveryDeps) {
    this.now = deps.now ?? Date.now
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.sweep() }, SWEEP_INTERVAL_MS)
    this.timer.unref?.()
    // Overdue continuations from before a restart run right away.
    void this.sweep()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  get(taskId: string): UsageLimitRecovery | null {
    return this.deps.store.get(taskId)
  }

  /** Records that the task's turn stopped on a usage limit. */
  recordStop(input: UsageLimitStopInput): UsageLimitRecovery {
    const now = this.now()
    const previous = this.deps.store.get(input.taskId)
    const hitAgain = previous?.status === 'resumed' && previous.resumedAt !== null && now - previous.resumedAt < REPEAT_WINDOW_MS
    const attempts = hitAgain ? previous!.attempts + 1 : 0
    // A reset that is not after the stop would immediately retry into the same limit.
    const resetMs = input.resetAt ? Date.parse(input.resetAt) : NaN
    const resetAt = Number.isFinite(resetMs) && resetMs > now ? new Date(resetMs).toISOString() : null
    const recovery: UsageLimitRecovery = {
      taskId: input.taskId,
      agentId: input.agentId,
      provider: input.provider,
      sessionId: input.sessionId,
      stoppedAt: now,
      resetAt,
      autoResume: this.deps.autoResumeEnabled() && attempts < MAX_CONSECUTIVE_AUTO_RESUMES,
      status: 'waiting',
      message: input.message,
      attempts,
      resumedAt: null,
      error: null
    }
    this.commit(recovery)
    return recovery
  }

  /** Fills unknown reset times from a fresh plan-limit snapshot of the same provider. */
  applyLimits(limits: ProviderUsageLimits): void {
    const resetAt = exhaustedWindowsResetAt(limits.windows)
    if (!resetAt || Date.parse(resetAt) <= this.now()) return
    for (const recovery of this.deps.store.listWaiting()) {
      if (recovery.provider === limits.provider && !recovery.resetAt) {
        this.commit({ ...recovery, resetAt })
      }
    }
  }

  /** Turns the scheduled continuation on or off for a waiting task. */
  setAutoResume(taskId: string, autoResume: boolean): UsageLimitRecovery | null {
    const recovery = this.deps.store.get(taskId)
    if (!recovery || recovery.status !== 'waiting') return recovery
    const next = { ...recovery, autoResume, attempts: autoResume ? 0 : recovery.attempts }
    this.commit(next)
    return next
  }

  /** The user (or the task) moved on: drop any pending continuation. */
  supersede(taskId: string): void {
    const recovery = this.deps.store.get(taskId)
    if (recovery?.status === 'waiting') this.commit({ ...recovery, status: 'superseded' })
  }

  /** Runs one pass: continues every recovery whose reset has passed. */
  async sweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      for (const recovery of this.deps.store.listWaiting()) {
        if (!recovery.autoResume || !recovery.resetAt) continue
        if (Date.parse(recovery.resetAt) + RESET_GRACE_MS > this.now()) continue
        await this.fire(recovery)
      }
    } finally {
      this.sweeping = false
    }
  }

  private async fire(recovery: UsageLimitRecovery): Promise<void> {
    const task = this.deps.getTaskState(recovery.taskId)
    if (!task.exists) {
      this.deps.store.delete(recovery.taskId)
      return
    }
    if (task.completed || (recovery.agentId && task.agentId !== recovery.agentId)) {
      this.commit({ ...recovery, status: 'superseded' })
      return
    }
    // Something is already running for the task; let it be and retry next sweep.
    if (task.busy) return

    const resumed: UsageLimitRecovery = { ...recovery, status: 'resumed', resumedAt: this.now() }
    this.commit(resumed)
    try {
      await this.deps.resume(resumed)
    } catch (error) {
      this.commit({ ...resumed, status: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }

  private commit(recovery: UsageLimitRecovery): void {
    this.deps.store.save(recovery)
    try {
      this.deps.emit(recovery)
    } catch (error) {
      console.warn('[UsageLimitRecovery] Failed to broadcast recovery update:', error)
    }
  }
}
