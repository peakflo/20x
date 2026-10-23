import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import RawDatabase from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { DatabaseManager } from './database'

/**
 * These tests exercise the REAL startup path — `initialize()` — instead of the
 * injected in-memory schema used by `createTestDb()`.
 *
 * That distinction matters. `createTestDb()` builds the tables from its own
 * `CREATE TABLE` copy, so it proves nothing about whether a migration actually
 * runs on an existing install. A column added to `runMigrations()` without
 * bumping `SCHEMA_VERSION` passed every other test in this repo and still
 * shipped broken: `initialize()` only calls `runMigrations()` when the stored
 * version is LOWER than `SCHEMA_VERSION`, so returning users never got it.
 */
describe('DatabaseManager migrations on an existing install', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), '20x-migration-'))
    vi.mocked(app.getPath).mockReturnValue(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function openRaw() {
    return new RawDatabase(join(dir, 'pf-desktop.db'))
  }

  function taskColumns(raw: InstanceType<typeof RawDatabase>): string[] {
    return (raw.pragma('table_info(tasks)') as { name: string }[]).map((c) => c.name)
  }

  it('creates a fresh database that already has every task column', () => {
    const db = new DatabaseManager()
    db.initialize()
    db.close?.()

    const raw = openRaw()
    expect(taskColumns(raw)).toContain('complete_at_source')
    raw.close()
  })

  /**
   * The regression this file exists for. Simulates a returning user: the column
   * is missing and the stored schema version is one behind. Startup must add it.
   */
  it('adds a column that a returning user is missing', () => {
    const first = new DatabaseManager()
    first.initialize()
    first.close?.()

    // Roll the database back to the previous release's shape.
    const raw = openRaw()
    raw.exec('ALTER TABLE tasks DROP COLUMN complete_at_source')
    raw.prepare("UPDATE settings SET value = ? WHERE key = '__schema_version'").run('8')
    expect(taskColumns(raw)).not.toContain('complete_at_source')
    raw.close()

    const second = new DatabaseManager()
    second.initialize()
    second.close?.()

    const after = openRaw()
    expect(taskColumns(after)).toContain('complete_at_source')
    after.close()
  })

  /**
   * Guards the gate itself. If someone adds an `ALTER TABLE` to
   * `runMigrations()` but leaves `SCHEMA_VERSION` alone, a returning user whose
   * stored version already equals `SCHEMA_VERSION` gets nothing — which is
   * exactly how `complete_at_source` shipped missing.
   */
  it('does not run migrations when the stored version already matches', () => {
    const first = new DatabaseManager()
    first.initialize()
    first.close?.()

    const raw = openRaw()
    const stored = raw
      .prepare("SELECT value FROM settings WHERE key = '__schema_version'")
      .get() as { value: string }
    // Drop the column WITHOUT lowering the version — the gate must skip it.
    raw.exec('ALTER TABLE tasks DROP COLUMN complete_at_source')
    raw.close()

    const second = new DatabaseManager()
    second.initialize()
    second.close?.()

    const after = openRaw()
    expect(taskColumns(after)).not.toContain('complete_at_source')
    after.close()

    // Documents the coupling: a new migration is only reachable by raising this.
    expect(Number(stored.value)).toBeGreaterThanOrEqual(9)
  })

  it('backfills tasks already in review as seen when adding the review seen columns', () => {
    const first = new DatabaseManager()
    first.initialize()
    const review = first.createTask({ title: 'In review', status: 'ready_for_review' })!
    const working = first.createTask({ title: 'Working', status: 'agent_working' })!
    first.close?.()

    // Roll back to the previous release: no review seen columns, version 10.
    const raw = openRaw()
    raw.exec('ALTER TABLE tasks DROP COLUMN review_entered_at')
    raw.exec('ALTER TABLE tasks DROP COLUMN review_seen_at')
    raw.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run('2026-01-02T03:04:05.000Z', review.id)
    raw.prepare("UPDATE settings SET value = ? WHERE key = '__schema_version'").run('10')
    raw.close()

    const second = new DatabaseManager()
    second.initialize()
    const reviewAfter = second.getTask(review.id)!
    const workingAfter = second.getTask(working.id)!
    expect(reviewAfter.review_entered_at).toBe('2026-01-02T03:04:05.000Z')
    expect(reviewAfter.review_seen_at).toBe('2026-01-02T03:04:05.000Z')
    expect(workingAfter.review_entered_at).toBeNull()
    expect(workingAfter.review_seen_at).toBeNull()
    // Nothing lights up as unseen right after the upgrade.
    expect(second.getUnseenReviewTaskIds()).toEqual([])
    second.close?.()
  })

  /**
   * Regression for a real stuck install: `__schema_version` already read 11
   * (the old `SCHEMA_VERSION`) but `tasks.review_entered_at` /
   * `review_seen_at` didn't exist — most likely because some other build
   * claimed version 11 for an unrelated change before this release's
   * migration ever ran. The version gate alone can never recover from this
   * (11 < 11 is false forever), so createTask()'s INSERT, which always lists
   * `review_entered_at`, failed with "table tasks has no column named
   * review_entered_at" on every attempt to create a task. Bumping
   * `SCHEMA_VERSION` past the stuck value is what unsticks it — the
   * per-column checks in `migrateReviewSeenColumns()` just re-add what's
   * actually missing.
   */
  it('recovers a database stuck at schema version 11 without the review seen columns', () => {
    const first = new DatabaseManager()
    first.initialize()
    first.close?.()

    // Simulate the stuck state: version already at the old SCHEMA_VERSION,
    // but the columns it was supposed to have added were never applied.
    const raw = openRaw()
    raw.exec('ALTER TABLE tasks DROP COLUMN review_entered_at')
    raw.exec('ALTER TABLE tasks DROP COLUMN review_seen_at')
    raw.prepare("UPDATE settings SET value = ? WHERE key = '__schema_version'").run('11')
    expect(taskColumns(raw)).not.toContain('review_entered_at')
    raw.close()

    const second = new DatabaseManager()
    second.initialize()
    expect(() => second.createTask({ title: 'Should not throw' })).not.toThrow()
    second.close?.()

    const after = openRaw()
    expect(taskColumns(after)).toContain('review_entered_at')
    expect(taskColumns(after)).toContain('review_seen_at')
    after.close()
  })

  it('migrates existing push subscriptions and removes duplicate endpoints', () => {
    const first = new DatabaseManager()
    first.initialize()
    first.close?.()

    const raw = openRaw()
    raw.exec(`DROP TABLE mobile_push_subscriptions;
      CREATE TABLE mobile_push_subscriptions (
        session_id TEXT PRIMARY KEY REFERENCES mobile_sessions(id) ON DELETE CASCADE,
        subscription TEXT NOT NULL
      );`)
    raw.prepare('INSERT INTO mobile_sessions (id, token_hash, device_name) VALUES (?, ?, ?)').run('old', 'old-hash', 'Phone')
    raw.prepare('INSERT INTO mobile_sessions (id, token_hash, device_name) VALUES (?, ?, ?)').run('new', 'new-hash', 'Phone')
    const subscription = JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/same', keys: { p256dh: 'a', auth: 'b' } })
    raw.prepare('INSERT INTO mobile_push_subscriptions (session_id, subscription) VALUES (?, ?)').run('old', subscription)
    raw.prepare('INSERT INTO mobile_push_subscriptions (session_id, subscription) VALUES (?, ?)').run('new', subscription)
    raw.close()

    const second = new DatabaseManager()
    second.initialize()
    expect(second.getMobilePushSubscriptions()).toHaveLength(1)
    expect(second.getMobilePushSubscriptions()[0].endpoint).toBe('https://fcm.googleapis.com/fcm/send/same')
    second.close?.()
  })
})
