/**
 * Durable, deduplicated parent wake-ups.
 *
 * Problem this replaces: `AgentManager.notifyParentOfSubtaskCompletion` used
 * to decide synchronously, in one call, whether a parent coordinator could be
 * woken right now — and if the parent's live session was busy, the wake-up
 * was simply dropped (dedup was only an in-memory `wakingParents` Set, which
 * is gone the moment the app restarts or a second wake-up for the same
 * parent is deferred).
 *
 * Design (mirrors `usage-limit-recovery.ts`'s durable-row + sweep shape):
 * - One row per child→parent transition in `task_wakeups`, keyed by a
 *   deterministic `delivery_id` (UNIQUE) so the same transition can never
 *   enqueue twice — even across a restart, even if the caller retries.
 * - `tryDeliver(parentTaskId)` combines every still-pending row for that
 *   parent into a single system message and attempts to send it. It is
 *   called immediately after enqueueing (fast path), again whenever the
 *   parent's session transitions to idle (the old "wake on idle" path),
 *   and from a periodic sweep (retry-with-backoff for sends that failed or
 *   parents that were busy).
 * - A send is only considered "delivered" once the caller's `send` callback
 *   resolves; rows are marked delivered only then. A throwing `send`
 *   increments `attempts`/`last_error` on every row in the batch, backs off
 *   exponentially before the next retry, and — past `MAX_DELIVERY_ATTEMPTS`
 *   — gives up permanently (`given_up_at`) with a visible transcript note on
 *   the parent, rather than retrying forever.
 * - Respects the existing rules: no delivery to a completed parent (rows for
 *   a completed or deleted parent are retired immediately, not left pending
 *   forever — so a later reopen never surfaces stale wake-ups), and (in the
 *   default "wait for all" mode) deferred while any sibling subtask is still
 *   `agent_working`/`triaging`. `deliveryMode: 'per-child'` is a reusable
 *   escape hatch for a future PR that wants a wake-up to go out the moment
 *   its own child finishes, without waiting on siblings.
 * - `markObserved(parentTaskId, childTaskId)` consumes a pending wake-up
 *   without sending anything, when the parent has already learned the same
 *   result through another channel (today: `wait_for_subtasks` — the one
 *   route that is unambiguously agent-coordination, never the renderer or
 *   mobile UI, so consuming it here can't silently swallow a wake-up a human
 *   was waiting to see delivered as a message).
 */

import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { buildSystemMessage, computeDeliveryId, SystemMessageOrigin } from '../../shared/system-authority'

export type WakeupReason = 'child_ready' | 'child_completed' | 'child_error' | 'child_question'

export interface WakeupPayload {
  childTitle: string
  childStatus: string
  [key: string]: unknown
}

export interface Wakeup {
  id: string
  parentTaskId: string
  childTaskId: string
  reason: WakeupReason
  deliveryId: string
  payload: WakeupPayload
  createdAt: number
  deliveredAt: number | null
  attempts: number
  lastError: string | null
  lastAttemptAt: number | null
  givenUpAt: number | null
}

interface WakeupRow {
  id: string
  parent_task_id: string
  child_task_id: string
  reason: string
  delivery_id: string
  payload: string
  created_at: number
  delivered_at: number | null
  attempts: number
  last_error: string | null
  last_attempt_at: number | null
  given_up_at: number | null
}

function fromRow(row: WakeupRow): Wakeup {
  let payload: WakeupPayload
  try {
    payload = JSON.parse(row.payload) as WakeupPayload
  } catch {
    payload = { childTitle: row.child_task_id, childStatus: 'unknown' }
  }
  return {
    id: row.id,
    parentTaskId: row.parent_task_id,
    childTaskId: row.child_task_id,
    reason: row.reason as WakeupReason,
    deliveryId: row.delivery_id,
    payload,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    attempts: row.attempts,
    lastError: row.last_error,
    lastAttemptAt: row.last_attempt_at,
    givenUpAt: row.given_up_at
  }
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS task_wakeups (
    id TEXT PRIMARY KEY,
    parent_task_id TEXT NOT NULL,
    child_task_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_attempt_at INTEGER,
    given_up_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_task_wakeups_delivery_id ON task_wakeups(delivery_id);
  CREATE INDEX IF NOT EXISTS idx_task_wakeups_parent_pending ON task_wakeups(parent_task_id, delivered_at);
`

export interface EnqueueWakeupInput {
  parentTaskId: string
  childTaskId: string
  reason: WakeupReason
  deliveryId: string
  payload: WakeupPayload
}

/** A row counts as "pending" only while neither delivered NOR given up — a permanently-failed row must stop showing up for retry. */
const PENDING_WHERE = 'delivered_at IS NULL AND given_up_at IS NULL'

export class TaskWakeupStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(SCHEMA_SQL)
  }

  /** Insert a row if `deliveryId` hasn't been seen before. Returns null when it's a duplicate. */
  enqueue(input: EnqueueWakeupInput, nowMs: number): Wakeup | null {
    const id = randomUUID()
    try {
      this.db
        .prepare(
          `INSERT INTO task_wakeups (id, parent_task_id, child_task_id, reason, delivery_id, payload, created_at, delivered_at, attempts, last_error, last_attempt_at, given_up_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, NULL)`
        )
        .run(id, input.parentTaskId, input.childTaskId, input.reason, input.deliveryId, JSON.stringify(input.payload), nowMs)
    } catch (err) {
      // UNIQUE(delivery_id) violation: this exact transition was already enqueued.
      if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) return null
      throw err
    }
    return this.get(id)
  }

  get(id: string): Wakeup | null {
    const row = this.db.prepare('SELECT * FROM task_wakeups WHERE id = ?').get(id) as WakeupRow | undefined
    return row ? fromRow(row) : null
  }

  listPending(parentTaskId: string): Wakeup[] {
    return (
      this.db
        .prepare(`SELECT * FROM task_wakeups WHERE parent_task_id = ? AND ${PENDING_WHERE} ORDER BY created_at`)
        .all(parentTaskId) as WakeupRow[]
    ).map(fromRow)
  }

  /** Distinct parent task ids with at least one still-pending (not delivered, not given up) wake-up. */
  listParentsWithPending(): string[] {
    return (this.db.prepare(`SELECT DISTINCT parent_task_id FROM task_wakeups WHERE ${PENDING_WHERE}`).all() as Array<{
      parent_task_id: string
    }>).map((r) => r.parent_task_id)
  }

  markDelivered(ids: string[], deliveredAtMs: number): void {
    if (ids.length === 0) return
    const stmt = this.db.prepare('UPDATE task_wakeups SET delivered_at = ?, last_error = NULL WHERE id = ?')
    const tx = this.db.transaction((rows: string[]) => {
      for (const id of rows) stmt.run(deliveredAtMs, id)
    })
    tx(ids)
  }

  recordFailure(ids: string[], error: string, attemptedAtMs: number): void {
    if (ids.length === 0) return
    const stmt = this.db.prepare('UPDATE task_wakeups SET attempts = attempts + 1, last_error = ?, last_attempt_at = ? WHERE id = ?')
    const tx = this.db.transaction((rows: string[]) => {
      for (const id of rows) stmt.run(error, attemptedAtMs, id)
    })
    tx(ids)
  }

  /** Permanently stops retrying these rows (past the attempt cap, or the parent is gone/completed) — never "delivered", but no longer "pending" either. */
  giveUp(ids: string[], givenUpAtMs: number): void {
    if (ids.length === 0) return
    const stmt = this.db.prepare('UPDATE task_wakeups SET given_up_at = ? WHERE id = ?')
    const tx = this.db.transaction((rows: string[]) => {
      for (const id of rows) stmt.run(givenUpAtMs, id)
    })
    tx(ids)
  }

  /** Marks every pending wake-up for (parentTaskId, childTaskId) delivered WITHOUT sending anything — the parent already observed this child's result through another channel. */
  markObserved(parentTaskId: string, childTaskId: string, observedAtMs: number): number {
    const rows = this.db
      .prepare(`SELECT id FROM task_wakeups WHERE parent_task_id = ? AND child_task_id = ? AND ${PENDING_WHERE}`)
      .all(parentTaskId, childTaskId) as Array<{ id: string }>
    if (rows.length === 0) return 0
    this.markDelivered(rows.map((r) => r.id), observedAtMs)
    return rows.length
  }

  /** Drops delivered rows older than `olderThanMs` ago, so the table doesn't grow forever. */
  pruneDelivered(nowMs: number, olderThanMs: number): number {
    const result = this.db
      .prepare('DELETE FROM task_wakeups WHERE delivered_at IS NOT NULL AND delivered_at < ?')
      .run(nowMs - olderThanMs)
    return result.changes
  }
}

export interface SubtaskSnapshot {
  id: string
  title: string
  status: string
}

export interface ParentDeliveryContext {
  exists: boolean
  completed: boolean
  /** True when the parent has a live session that is NOT idle (so a send would be lost/confusing). */
  sessionBusy: boolean
  subtasks: SubtaskSnapshot[]
}

export type WakeupDeliveryMode = 'wait-for-all' | 'per-child'

export interface TaskWakeupDeps {
  store: TaskWakeupStore
  getDeliveryContext: (parentTaskId: string) => ParentDeliveryContext
  /** Sends the combined message to the parent's task session. Throw to signal a failed send. */
  send: (parentTaskId: string, message: string) => Promise<void>
  /** Called once a batch of rows has exhausted its retry budget — give the parent a visible note instead of silently dropping them. Never throws into the caller. */
  onGivenUp?: (parentTaskId: string, wakeups: Wakeup[]) => void
  mode?: WakeupDeliveryMode
  now?: () => number
}

const SWEEP_INTERVAL_MS = 30 * 1000
const DELIVERED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const PRUNE_MIN_INTERVAL_MS = 60 * 60 * 1000
/** Past this many failed attempts, a wake-up gives up instead of retrying forever. */
const MAX_DELIVERY_ATTEMPTS = 5
/** Exponential backoff off the sweep cadence, capped at 30 minutes between retries. */
const MAX_BACKOFF_MS = 30 * 60 * 1000

/**
 * Builds a deterministic delivery id for one child→parent transition.
 * Same (parent, child, statusEnteredAt, reason) → same id, so the same
 * transition is never enqueued twice — including across a restart.
 */
export function computeWakeupDeliveryId(parentTaskId: string, childTaskId: string, statusEnteredAt: string, reason: WakeupReason): string {
  return computeDeliveryId(`${parentTaskId}:${childTaskId}:${reason}`, statusEnteredAt)
}

function backoffMs(attempts: number): number {
  return Math.min(SWEEP_INTERVAL_MS * 2 ** attempts, MAX_BACKOFF_MS)
}

export class TaskWakeupQueue {
  private timer: ReturnType<typeof setInterval> | null = null
  private sweeping = false
  private lastPruneAtMs = 0
  private readonly now: () => number
  private readonly mode: WakeupDeliveryMode
  /** In-flight delivery attempts, so a sweep tick can't race a just-enqueued immediate attempt for the same parent. */
  private readonly delivering = new Set<string>()

  constructor(private readonly deps: TaskWakeupDeps) {
    this.now = deps.now ?? Date.now
    this.mode = deps.mode ?? 'wait-for-all'
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.sweep()
    }, SWEEP_INTERVAL_MS)
    this.timer.unref?.()
    // Deliver every pending row that is still valid, picked up from before a restart.
    void this.sweep()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * One sweep pass: attempts delivery for every parent with at least one
   * pending wake-up. Safe to call directly (tests, startup) or on a timer —
   * `tryDeliver` is itself a no-op whenever the parent can't take it yet.
   * Also prunes long-delivered rows, throttled to once an hour of sweeps.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      for (const parentTaskId of this.deps.store.listParentsWithPending()) {
        await this.tryDeliver(parentTaskId)
      }
      const nowMs = this.now()
      if (nowMs - this.lastPruneAtMs >= PRUNE_MIN_INTERVAL_MS) {
        this.lastPruneAtMs = nowMs
        this.pruneOldDelivered()
      }
    } finally {
      this.sweeping = false
    }
  }

  /** Enqueues one child→parent wake-up, then attempts immediate delivery. Returns the queued row, or null if this exact transition was already enqueued. */
  async enqueueAndTryDeliver(input: EnqueueWakeupInput): Promise<Wakeup | null> {
    const wakeup = this.deps.store.enqueue(input, this.now())
    if (!wakeup) return null
    await this.tryDeliver(input.parentTaskId)
    return wakeup
  }

  /**
   * Consumes a pending wake-up without sending anything, because the parent
   * has already observed this child's result through another channel (see
   * the module doc for why only `wait_for_subtasks` is a safe caller of
   * this today).
   */
  markObserved(parentTaskId: string, childTaskId: string): number {
    return this.deps.store.markObserved(parentTaskId, childTaskId, this.now())
  }

  /**
   * Attempts to deliver every pending wake-up for one parent as a single
   * combined message. No-ops (leaving rows pending) when the parent can't
   * take it right now — nothing is ever silently dropped while it's still
   * retryable. Retires rows for a parent that no longer exists or already
   * completed (it will never accept them, so leaving them pending forever,
   * only to surface if the parent is later reopened, would be worse).
   */
  async tryDeliver(parentTaskId: string): Promise<void> {
    if (this.delivering.has(parentTaskId)) return
    const pending = this.deps.store.listPending(parentTaskId)
    if (pending.length === 0) return

    const ctx = this.deps.getDeliveryContext(parentTaskId)
    if (!ctx.exists || ctx.completed) {
      this.giveUp(parentTaskId, pending, ctx.exists ? 'the parent task is already completed' : 'the parent task no longer exists')
      return
    }
    if (ctx.sessionBusy) return

    if (this.mode === 'wait-for-all') {
      const stillWorking = ctx.subtasks.some((s) => s.status === 'agent_working' || s.status === 'triaging')
      if (stillWorking) return
    }

    // Exponential backoff: a row that failed recently waits its own window
    // before the next retry, instead of hammering a send that just failed.
    const nowMs = this.now()
    const deliverable = pending.filter(
      (w) => w.attempts === 0 || w.lastAttemptAt === null || nowMs - w.lastAttemptAt >= backoffMs(w.attempts)
    )
    if (deliverable.length === 0) return

    this.delivering.add(parentTaskId)
    try {
      const message = this.buildMessage(parentTaskId, deliverable, ctx.subtasks)
      try {
        await this.deps.send(parentTaskId, message)
        this.deps.store.markDelivered(deliverable.map((w) => w.id), this.now())
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        const attemptAtMs = this.now()
        this.deps.store.recordFailure(deliverable.map((w) => w.id), errorMessage, attemptAtMs)
        console.error(`[TaskWakeupQueue] Failed to deliver ${deliverable.length} wake-up(s) to parent ${parentTaskId}:`, err)

        const exhausted = deliverable.filter((w) => w.attempts + 1 >= MAX_DELIVERY_ATTEMPTS)
        if (exhausted.length > 0) {
          this.giveUp(parentTaskId, exhausted, `delivery failed ${MAX_DELIVERY_ATTEMPTS} times: ${errorMessage}`)
        }
      }
    } finally {
      this.delivering.delete(parentTaskId)
    }
  }

  private giveUp(parentTaskId: string, wakeups: Wakeup[], reason: string): void {
    this.deps.store.giveUp(wakeups.map((w) => w.id), this.now())
    console.warn(`[TaskWakeupQueue] Giving up on ${wakeups.length} wake-up(s) for parent ${parentTaskId}: ${reason}`)
    try {
      this.deps.onGivenUp?.(parentTaskId, wakeups)
    } catch (err) {
      console.error(`[TaskWakeupQueue] onGivenUp callback threw for parent ${parentTaskId}:`, err)
    }
  }

  private buildMessage(parentTaskId: string, wakeups: Wakeup[], subtasks: SubtaskSnapshot[]): string {
    const summary = wakeups.map((w) => `- "${w.payload.childTitle}" (id: ${w.childTaskId}) → ${w.payload.childStatus} [${w.reason}]`).join('\n')
    const allTerminal = subtasks.every(
      (s) => s.status === 'ready_for_review' || s.status === 'completed' || s.status === 'model_error'
    )
    const instructions = allTerminal
      ? `Use \`get_task\` / \`list_subtasks\` via the task-management MCP server to review their outputs, ` +
        `then continue coordination: consolidate results, fill in the parent task's output fields, ` +
        `and complete the task — or create follow-up subtasks if more work is needed.`
      : `Use \`get_task\` / \`list_subtasks\` via the task-management MCP server to review the ready subtask's outputs, ` +
        `then continue coordination: start the next not_started subtask, create follow-up subtasks if more work ` +
        `is needed, or consolidate results and complete the task.`
    const header =
      wakeups.length > 1
        ? `${wakeups.length} subtask wake-up(s) are waiting for this task.`
        : allTerminal
          ? 'All subtasks of this task have reached a terminal state.'
          : 'No subtask of this task is in agent_working anymore — the last one reached ready_for_review.'

    return buildSystemMessage(
      {
        origin: SystemMessageOrigin.Coordinator,
        taskId: parentTaskId,
        deliveryId: computeDeliveryId(parentTaskId, wakeups.map((w) => w.deliveryId).join(',')),
        generatedAt: new Date(this.now()).toISOString()
      },
      header,
      summary,
      instructions
    )
  }

  /** Drops delivered rows older than 7 days. Safe to call on a timer or on startup. Called automatically from `sweep()`, throttled to once an hour. */
  pruneOldDelivered(): number {
    return this.deps.store.pruneDelivered(this.now(), DELIVERED_RETENTION_MS)
  }
}
