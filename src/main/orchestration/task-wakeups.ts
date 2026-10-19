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
 *   increments `attempts`/`last_error` on every row in the batch and leaves
 *   them pending — nothing is ever dropped.
 * - Respects the existing rules: no delivery to a completed parent, and
 *   (in the default "wait for all" mode) deferred while any sibling subtask
 *   is still `agent_working`/`triaging`. `deliveryMode: 'per-child'` is a
 *   reusable escape hatch for a future PR that wants a wake-up to go out the
 *   moment its own child finishes, without waiting on siblings.
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
    lastError: row.last_error
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
    last_error TEXT
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
          `INSERT INTO task_wakeups (id, parent_task_id, child_task_id, reason, delivery_id, payload, created_at, delivered_at, attempts, last_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL)`
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
        .prepare('SELECT * FROM task_wakeups WHERE parent_task_id = ? AND delivered_at IS NULL ORDER BY created_at')
        .all(parentTaskId) as WakeupRow[]
    ).map(fromRow)
  }

  /** Distinct parent task ids with at least one undelivered wake-up. */
  listParentsWithPending(): string[] {
    return (this.db.prepare('SELECT DISTINCT parent_task_id FROM task_wakeups WHERE delivered_at IS NULL').all() as Array<{
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

  recordFailure(ids: string[], error: string): void {
    if (ids.length === 0) return
    const stmt = this.db.prepare('UPDATE task_wakeups SET attempts = attempts + 1, last_error = ? WHERE id = ?')
    const tx = this.db.transaction((rows: string[]) => {
      for (const id of rows) stmt.run(error, id)
    })
    tx(ids)
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
  mode?: WakeupDeliveryMode
  now?: () => number
}

const SWEEP_INTERVAL_MS = 30 * 1000
const DELIVERED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Builds a deterministic delivery id for one child→parent transition.
 * Same (parent, child, statusEnteredAt, reason) → same id, so the same
 * transition is never enqueued twice — including across a restart.
 */
export function computeWakeupDeliveryId(parentTaskId: string, childTaskId: string, statusEnteredAt: string, reason: WakeupReason): string {
  return computeDeliveryId(`${parentTaskId}:${childTaskId}:${reason}`, statusEnteredAt)
}

export class TaskWakeupQueue {
  private timer: ReturnType<typeof setInterval> | null = null
  private sweeping = false
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
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      for (const parentTaskId of this.deps.store.listParentsWithPending()) {
        await this.tryDeliver(parentTaskId)
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
   * Attempts to deliver every pending wake-up for one parent as a single
   * combined message. No-ops (leaving rows pending) when the parent can't
   * take it right now — nothing is ever dropped.
   */
  async tryDeliver(parentTaskId: string): Promise<void> {
    if (this.delivering.has(parentTaskId)) return
    const pending = this.deps.store.listPending(parentTaskId)
    if (pending.length === 0) return

    const ctx = this.deps.getDeliveryContext(parentTaskId)
    if (!ctx.exists || ctx.completed) return
    if (ctx.sessionBusy) return

    const deliverable = pending
    if (this.mode === 'wait-for-all') {
      const stillWorking = ctx.subtasks.some((s) => s.status === 'agent_working' || s.status === 'triaging')
      if (stillWorking) return
    }
    if (deliverable.length === 0) return

    this.delivering.add(parentTaskId)
    try {
      const message = this.buildMessage(parentTaskId, deliverable, ctx.subtasks)
      try {
        await this.deps.send(parentTaskId, message)
        this.deps.store.markDelivered(deliverable.map((w) => w.id), this.now())
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        this.deps.store.recordFailure(deliverable.map((w) => w.id), errorMessage)
        console.error(`[TaskWakeupQueue] Failed to deliver ${deliverable.length} wake-up(s) to parent ${parentTaskId}:`, err)
      }
    } finally {
      this.delivering.delete(parentTaskId)
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

  /** Drops delivered rows older than 7 days. Safe to call on a timer or on startup. */
  pruneOldDelivered(): number {
    return this.deps.store.pruneDelivered(this.now(), DELIVERED_RETENTION_MS)
  }
}
