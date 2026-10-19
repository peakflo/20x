import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { DatabaseManager } from '../database'
import { withIdempotency, pruneExpiredOrchestrationReceiptsOnce, ORCHESTRATION_RECEIPT_TTL_MS, __resetPruneThrottleForTests } from './idempotency'

function makeDb(): DatabaseManager {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE IF NOT EXISTS orchestration_receipts (
      scope TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      result TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (scope, client_request_id)
    );
  `)
  const db = new DatabaseManager()
  ;(db as unknown as { db: InstanceType<typeof Database> }).db = raw
  return db
}

describe('withIdempotency', () => {
  let db: DatabaseManager

  beforeEach(() => {
    db = makeDb()
    __resetPruneThrottleForTests()
  })

  it('runs fn and returns its result when no client_request_id is given', async () => {
    const fn = vi.fn(async () => ({ created: true }))
    const result = await withIdempotency(db, 'task:1', undefined, fn)
    expect(result).toEqual({ created: true })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('runs fn again on every call with no client_request_id — no bookkeeping at all', async () => {
    const fn = vi.fn(async () => ({ n: Math.random() }))
    await withIdempotency(db, 'task:1', null, fn)
    await withIdempotency(db, 'task:1', undefined, fn)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('a retried call with the same (scope, client_request_id) returns the stored result without running fn again', async () => {
    const fn = vi.fn(async () => ({ taskId: 'task-abc' }))
    const first = await withIdempotency(db, 'task:parent-1', 'req-1', fn)
    const second = await withIdempotency(db, 'task:parent-1', 'req-1', fn)

    expect(first).toEqual({ taskId: 'task-abc' })
    expect(second).toEqual({ taskId: 'task-abc' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('a different client_request_id in the same scope runs fn independently', async () => {
    const fn = vi.fn(async () => ({ n: fn.mock.calls.length }))
    await withIdempotency(db, 'task:parent-1', 'req-1', fn)
    await withIdempotency(db, 'task:parent-1', 'req-2', fn)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('the same client_request_id in a DIFFERENT scope runs fn independently', async () => {
    const fn = vi.fn(async () => ({ n: fn.mock.calls.length }))
    await withIdempotency(db, 'task:parent-1', 'req-1', fn)
    await withIdempotency(db, 'task:parent-2', 'req-1', fn)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('a genuinely concurrent duplicate call waits for the in-flight one and returns its result, never running fn itself', async () => {
    let release!: () => void
    let calls = 0
    const fn = vi.fn(async () => {
      calls += 1
      // Hold the first call open until the test explicitly releases it, so
      // the second call unambiguously arrives while the first is still "in
      // flight" (claimed, not yet completed) — not a sequential retry.
      await new Promise<void>((resolve) => { release = resolve })
      return { call: calls }
    })

    const first = withIdempotency(db, 'task:race', 'req-race', fn)
    // Let the first call actually claim the key before the second starts.
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = withIdempotency(db, 'task:race', 'req-race', fn)
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()

    const [a, b] = await Promise.all([first, second])
    expect(calls).toBe(1) // fn ran exactly once — the second caller never raced into it
    expect(a).toEqual(b)
    expect(a).toEqual({ call: 1 })
  })

  it('a concurrent duplicate throws a clear error instead of hanging if the in-flight call fails (claim released, nothing to return)', async () => {
    let release!: (err: Error) => void
    const fn = vi.fn(() => new Promise<never>((_resolve, reject) => { release = reject }))

    const first = withIdempotency(db, 'task:race-fail', 'req-1', fn)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = withIdempotency(db, 'task:race-fail', 'req-1', fn)
    release(new Error('boom'))

    await expect(first).rejects.toThrow('boom')
    await expect(second).rejects.toThrow(/did not complete successfully/)
  })

  it('fn throwing releases the claim — a retry with the same key runs fresh instead of being stuck forever', async () => {
    const failingFn = vi.fn(async () => { throw new Error('transient failure') })
    await expect(withIdempotency(db, 'task:retry', 'req-1', failingFn)).rejects.toThrow('transient failure')

    const succeedingFn = vi.fn(async () => ({ ok: true }))
    const result = await withIdempotency(db, 'task:retry', 'req-1', succeedingFn)

    expect(result).toEqual({ ok: true })
    expect(succeedingFn).toHaveBeenCalledTimes(1)
  })

  it('shouldCache=false releases the claim instead of caching a "nothing happened" result, so a retry after fixing the cause runs fresh', async () => {
    let attempt = 0
    const fn = vi.fn(async () => {
      attempt += 1
      return attempt === 1 ? { success: false, reason: 'no_agent' } : { success: true, reason: 'started' }
    })
    const shouldCache = (r: { success: boolean }) => r.success

    const first = await withIdempotency(db, 'task:soft-fail', 'req-1', fn, shouldCache)
    expect(first).toEqual({ success: false, reason: 'no_agent' })

    // Retried with the SAME client_request_id after whatever caused the
    // no-op was fixed — must try again, not replay the cached no-op.
    const second = await withIdempotency(db, 'task:soft-fail', 'req-1', fn, shouldCache)
    expect(second).toEqual({ success: true, reason: 'started' })
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('shouldCache=true (the default) still caches a genuine success exactly as before', async () => {
    const fn = vi.fn(async () => ({ success: true }))
    await withIdempotency(db, 'task:ok', 'req-1', fn)
    await withIdempotency(db, 'task:ok', 'req-1', fn)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('pruneExpiredOrchestrationReceiptsOnce', () => {
  let db: DatabaseManager

  beforeEach(() => {
    db = makeDb()
    __resetPruneThrottleForTests()
  })

  it('deletes receipts older than the TTL and keeps fresh ones', async () => {
    const dayMs = 24 * 60 * 60 * 1000
    const now = Date.UTC(2026, 9, 19, 12, 0, 0)

    await withIdempotency(db, 'task:old', 'req-old', async () => ({ ok: true }))
    await withIdempotency(db, 'task:fresh', 'req-fresh', async () => ({ ok: true }))

    // Backdate the "old" receipt past the 7-day TTL directly (the receipt
    // itself doesn't take a clock — only the prune call below does).
    const raw = (db as unknown as { db: InstanceType<typeof Database> }).db
    raw.prepare('UPDATE orchestration_receipts SET created_at = ? WHERE scope = ?')
      .run(now - ORCHESTRATION_RECEIPT_TTL_MS - dayMs, 'task:old')

    pruneExpiredOrchestrationReceiptsOnce(db, now)

    expect(db.getOrchestrationReceipt('task:old', 'req-old')).toBeNull()
    expect(db.getOrchestrationReceipt('task:fresh', 'req-fresh')).not.toBeNull()
  })

  it('does not prune again within the throttle window', () => {
    const now = Date.UTC(2026, 9, 19, 12, 0, 0)
    const spy = vi.spyOn(db, 'pruneExpiredOrchestrationReceipts')
    pruneExpiredOrchestrationReceiptsOnce(db, now)
    pruneExpiredOrchestrationReceiptsOnce(db, now + 1000)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('swallows a database error instead of throwing', () => {
    const now = Date.UTC(2026, 9, 19, 12, 0, 0)
    vi.spyOn(db, 'pruneExpiredOrchestrationReceipts').mockImplementation(() => {
      throw new Error('disk full')
    })
    expect(() => pruneExpiredOrchestrationReceiptsOnce(db, now)).not.toThrow()
  })
})
