/**
 * Idempotency for orchestration MCP tools (create_task, create_subtask,
 * start_task, send_message). A coordinator agent that cannot tell whether an
 * earlier call actually landed (its own turn was cut short, the transport
 * dropped the response, ...) retries with the SAME `client_request_id`. This
 * module makes that retry return the original result instead of creating a
 * second task or sending a second message.
 *
 * Storage: `orchestration_receipts (scope, client_request_id, result, created_at)`
 * — see the `task-api-server.ts` call sites for how `scope` is derived.
 * `scope` MUST include the route name, not just the target task/parent id:
 * `start_task` and `send_message` on the SAME task id are different
 * operations, and a `client_request_id` happening to repeat across them
 * (an agent reusing a short counter like "req-1") must not return one
 * tool's cached result for the other.
 *
 * Known gap: a root-level `create_task` (no parent) has no caller identity
 * to scope by — the MCP dispatch layer (`task-management-core.ts`) only
 * carries a scope (parentTaskId/taskId) for a SCOPED (subtask) session; an
 * unscoped Mastermind/root call reaches `task-api-server.ts` with no caller
 * id at all. Until that's threaded through, root `create_task` receipts
 * share one bucket per route, keyed only by `client_request_id` — a
 * deliberate, documented trade-off, not an oversight; see the PR discussion.
 *
 * Receipts older than {@link ORCHESTRATION_RECEIPT_TTL_MS} are pruned
 * opportunistically, not on a timer — see `pruneExpiredOrchestrationReceiptsOnce`.
 */
import type { DatabaseManager } from '../database'

/** Receipts older than this are no longer honored and are pruned on sight. */
export const ORCHESTRATION_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** How long a caller waits for a CONCURRENT duplicate call (same key, already in flight) to finish, before giving up. */
const CONCURRENT_WAIT_TIMEOUT_MS = 10_000
const CONCURRENT_POLL_INTERVAL_MS = 50

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Runs `fn` exactly once per (scope, clientRequestId): the first call claims
 * the key BEFORE running `fn` (so a genuinely concurrent duplicate sees the
 * claim, not a race between two "no receipt yet" reads), executes it, and
 * records the result. Every later call with the same key — sequential retry
 * or concurrent duplicate — returns that SAME result without running `fn`
 * again. A call with no `clientRequestId` (the common case — the parameter
 * is optional) always just runs `fn`, with no idempotency bookkeeping at
 * all — existing callers that never pass it see no behavior change.
 *
 * `shouldCache(result)` (default: always true) lets a caller opt out of
 * caching a "nothing really happened" outcome — e.g. `start_task` returning
 * `action: 'no_action'` because the task had no agent yet. Caching that
 * would make a retry AFTER fixing the actual cause (assigning an agent)
 * keep replaying the stale no-op forever within the TTL. When `fn`'s result
 * is not cached, the claim is released so the next call tries again fresh.
 *
 * `fn` throwing also releases the claim (never cached) — the next call
 * (same key) gets to try again, exactly like today's uncached path.
 */
export async function withIdempotency<T>(
  db: DatabaseManager,
  scope: string,
  clientRequestId: string | null | undefined,
  fn: () => T | Promise<T>,
  shouldCache: (result: T) => boolean = () => true
): Promise<T> {
  if (!clientRequestId) return await fn()

  const won = db.claimOrchestrationReceipt(scope, clientRequestId, Date.now())
  if (!won) {
    // Someone else already claimed this key — wait for it to resolve
    // (genuinely concurrent duplicate), or return immediately if it already
    // has (a sequential retry, the common case).
    return await waitForReceipt<T>(db, scope, clientRequestId)
  }

  try {
    const result = await fn()
    if (shouldCache(result)) {
      db.completeOrchestrationReceipt(scope, clientRequestId, result)
    } else {
      db.releaseOrchestrationReceiptClaim(scope, clientRequestId)
    }
    return result
  } catch (err) {
    db.releaseOrchestrationReceiptClaim(scope, clientRequestId)
    throw err
  }
}

/** Polls for a claimed-but-not-yet-completed receipt to finish, up to a timeout. */
async function waitForReceipt<T>(db: DatabaseManager, scope: string, clientRequestId: string): Promise<T> {
  const deadline = Date.now() + CONCURRENT_WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const existing = db.getOrchestrationReceipt(scope, clientRequestId)
    if (!existing) {
      // The in-flight caller released its claim (its own fn threw, or
      // decided not to cache) — nothing left to wait for.
      throw new Error(`A concurrent call with client_request_id "${clientRequestId}" did not complete successfully. Retry.`)
    }
    if (!existing.isPending) return existing.result as T
    await sleep(CONCURRENT_POLL_INTERVAL_MS)
  }
  throw new Error(`Timed out waiting for a concurrent call with client_request_id "${clientRequestId}" to finish.`)
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
