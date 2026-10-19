/**
 * Idempotency for orchestration MCP tools (create_task, create_subtask,
 * start_task, send_message). A coordinator agent that cannot tell whether an
 * earlier call actually landed (its own turn was cut short, the transport
 * dropped the response, ...) retries with the SAME `client_request_id`. This
 * module makes that retry return the original result instead of creating a
 * second task or sending a second message.
 *
 * Storage: `orchestration_receipts (scope, client_request_id, result, created_at)`
 * — see the `task_api-server.ts` call sites for how `scope` is derived (the
 * task/parent the call is scoped to; a plain 'global' bucket for a
 * root-level `create_task` with no parent). Receipts older than
 * {@link ORCHESTRATION_RECEIPT_TTL_MS} are pruned opportunistically, not on a
 * timer — see `pruneExpiredOrchestrationReceiptsOnce`.
 */
import type { DatabaseManager } from '../database'

/** Receipts older than this are no longer honored and are pruned on sight. */
export const ORCHESTRATION_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Runs `fn` exactly once per (scope, clientRequestId): a first call executes
 * it and stores the result; every later call with the same key returns the
 * stored result WITHOUT running `fn` again. A call with no `clientRequestId`
 * (the common case — the parameter is optional) always just runs `fn`, with
 * no idempotency bookkeeping at all — existing callers that never pass it
 * see no behavior change.
 *
 * Races: two concurrent callers with the same key can both see "no receipt
 * yet" and both run `fn` (better-sqlite3 is synchronous per-call, but the
 * JS event loop can still interleave two in-flight async `fn`s). The second
 * `putOrchestrationReceipt` is a harmless `ON CONFLICT DO NOTHING` — the
 * first writer's result is what every caller eventually reads back, so at
 * most one of the two side effects is "the" canonical one, never zero.
 */
export async function withIdempotency<T>(
  db: DatabaseManager,
  scope: string,
  clientRequestId: string | null | undefined,
  fn: () => T | Promise<T>
): Promise<T> {
  if (!clientRequestId) return await fn()

  const existing = db.getOrchestrationReceipt(scope, clientRequestId)
  if (existing) return existing.result as T

  const result = await fn()
  db.putOrchestrationReceipt(scope, clientRequestId, result, Date.now())
  // Read back the stored receipt so a race with a concurrent identical call
  // is resolved consistently: whichever write actually landed (ON CONFLICT
  // DO NOTHING) is what both callers return.
  const stored = db.getOrchestrationReceipt(scope, clientRequestId)
  return (stored?.result as T) ?? result
}

/** Settings key guarding how often the opportunistic prune runs (not a hard lock — just avoids pruning on every single call). */
const PRUNE_MIN_INTERVAL_MS = 60 * 60 * 1000
let lastPruneAtMs = 0

/**
 * Deletes expired receipts, at most once per hour of wall-clock calls. Called
 * from a few orchestration entry points (not a dedicated timer) so the table
 * never grows unbounded in a long-running app, without adding a new
 * scheduled job.
 */
export function pruneExpiredOrchestrationReceiptsOnce(db: DatabaseManager, nowMs: number = Date.now()): void {
  if (nowMs - lastPruneAtMs < PRUNE_MIN_INTERVAL_MS) return
  lastPruneAtMs = nowMs
  try {
    db.pruneExpiredOrchestrationReceipts(nowMs, ORCHESTRATION_RECEIPT_TTL_MS)
  } catch (err) {
    console.error('[Idempotency] pruneExpiredOrchestrationReceipts failed:', err)
  }
}

/** Test-only: resets the prune throttle so a test can assert pruning happened. */
export function __resetPruneThrottleForTests(): void {
  lastPruneAtMs = 0
}
