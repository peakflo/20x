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

  it('adds next_subtask_ids for a database from schema version 9', () => {
    const first = new DatabaseManager()
    first.initialize()
    first.close?.()

    const raw = openRaw()
    raw.exec('ALTER TABLE tasks DROP COLUMN next_subtask_ids')
    raw.prepare("UPDATE settings SET value = ? WHERE key = '__schema_version'").run('9')
    expect(taskColumns(raw)).not.toContain('next_subtask_ids')
    raw.close()

    const second = new DatabaseManager()
    second.initialize()
    second.close?.()

    const after = openRaw()
    expect(taskColumns(after)).toContain('next_subtask_ids')
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
})
