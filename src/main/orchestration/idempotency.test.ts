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
      result TEXT NOT NULL,
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

  it('resolves a race between two concurrent callers with the same key to one canonical result', async () => {
    let calls = 0
    const fn = vi.fn(async () => {
      calls += 1
      return { call: calls }
    })
    const [a, b] = await Promise.all([
      withIdempotency(db, 'task:race', 'req-race', fn),
      withIdempotency(db, 'task:race', 'req-race', fn)
    ])
    // Both callers raced past the "no receipt yet" check, so fn ran twice —
    // but ON CONFLICT DO NOTHING means only one write landed, and both callers
    // read back and return that SAME canonical result.
    expect(a).toEqual(b)
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
