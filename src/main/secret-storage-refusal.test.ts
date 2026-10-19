import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createTestDb } from '../../test/helpers/db-test-helper'
import type { DatabaseManager } from './database'

let db: DatabaseManager
let rawDb: import('better-sqlite3').Database

// The global test mock (test/setup-main.ts) makes encryptString/decryptString
// an identity pass-through, which can't model the real asymmetry this file's
// tests depend on. Override with a pair that models the REAL shape —
// Chromium os_crypt's own "v10" version prefix, empirically confirmed by
// actually calling safeStorage.encryptString in a real Electron process on
// this Mac (not a made-up marker like an earlier version of this fixture
// used, which the re-review correctly flagged: `isPlaintextFallback` now
// does a POSITIVE byte-prefix check, not a "did decrypt throw" check, so
// the fixture has to produce the prefix real encrypted bytes actually have
// — a decrypt-only throwing mock can no longer stand in for it.
const REAL_PREFIX = Buffer.from('v10', 'latin1')
const BACKUP_DIR = '/tmp/pf-desktop-test/secret-reencrypt-backups'

beforeEach(() => {
  ;({ db, rawDb } = createTestDb())
  vi.mocked(safeStorage.encryptString).mockImplementation((value: string) => Buffer.concat([REAL_PREFIX, Buffer.from(value, 'utf8')]))
  vi.mocked(safeStorage.decryptString).mockImplementation((buf: Buffer) => {
    if (!buf.subarray(0, REAL_PREFIX.length).equals(REAL_PREFIX)) throw new Error('not actually encrypted')
    return buf.subarray(REAL_PREFIX.length).toString('utf8')
  })
  rmSync(BACKUP_DIR, { recursive: true, force: true })
})

afterEach(() => {
  rmSync(BACKUP_DIR, { recursive: true, force: true })
})

describe('createSecret / updateSecret refuse plaintext when safeStorage is unavailable', () => {
  it('createSecret throws (and writes nothing) when encryption is unavailable', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    expect(() => db.createSecret({ name: 'K', description: '', env_var_name: 'MY_SECRET', value: 'leaked-secret-123456' }))
      .toThrow(/keychain|keyring/i)
    const rows = rawDb.prepare('SELECT COUNT(*) as c FROM secrets').get() as { c: number }
    expect(rows.c).toBe(0)
  })

  it('createSecret succeeds (and encrypts) when encryption is available', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    const secret = db.createSecret({ name: 'K', description: '', env_var_name: 'MY_SECRET', value: 'leaked-secret-123456' })
    expect(secret).toBeDefined()
    const row = rawDb.prepare('SELECT value FROM secrets WHERE id = ?').get(secret!.id) as { value: Buffer }
    expect(row.value.toString('utf8')).not.toBe('leaked-secret-123456') // actually encrypted, not raw bytes
  })

  it('updateSecret throws when changing the value while encryption is unavailable', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    const secret = db.createSecret({ name: 'K', description: '', env_var_name: 'MY_SECRET', value: 'leaked-secret-123456' })!

    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    expect(() => db.updateSecret(secret.id, { value: 'new-leaked-value-123456' })).toThrow(/keychain|keyring/i)
  })

  it('updateSecret still allows renaming/describing a secret without encryption (no new plaintext written)', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    const secret = db.createSecret({ name: 'K', description: '', env_var_name: 'MY_SECRET', value: 'leaked-secret-123456' })!

    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const updated = db.updateSecret(secret.id, { name: 'Renamed' })
    expect(updated?.name).toBe('Renamed')
  })

  it('isSecretEncryptionAvailable reflects safeStorage', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    expect(db.isSecretEncryptionAvailable()).toBe(false)
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    expect(db.isSecretEncryptionAvailable()).toBe(true)
  })
})

describe('reencryptPlaintextFallbackRows', () => {
  function insertLegacyPlaintextSecret(envVarName: string, value: string): string {
    // Simulates a row written by an older app version while safeStorage was
    // unavailable — bypasses createSecret (which now refuses this) by
    // inserting the raw bytes directly, matching the old fallback format.
    const id = `legacy-${envVarName.toLowerCase()}`
    const now = new Date().toISOString()
    rawDb.prepare(`
      INSERT INTO secrets (id, name, description, env_var_name, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, 'Legacy', '', envVarName, Buffer.from(value, 'utf8'), now, now)
    return id
  }

  it('no-ops when encryption is still unavailable', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    insertLegacyPlaintextSecret('MY_SECRET', 'leaked-secret-123456')
    expect(db.reencryptPlaintextFallbackRows()).toEqual({ secrets: 0, oauthTokens: 0 })
  })

  it('re-encrypts a legacy plaintext row once encryption becomes available', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const id = insertLegacyPlaintextSecret('MY_SECRET', 'leaked-secret-123456')

    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    const result = db.reencryptPlaintextFallbackRows()
    expect(result.secrets).toBe(1)

    // The row is no longer raw plaintext bytes...
    const row = rawDb.prepare('SELECT value FROM secrets WHERE id = ?').get(id) as { value: Buffer }
    expect(row.value.toString('utf8')).not.toBe('leaked-secret-123456')
    // ...but still decrypts back to the original value through the normal read path.
    const [withValue] = db.getSecretsWithValues([id])
    expect(withValue.value).toBe('leaked-secret-123456')
  })

  it('is idempotent — a second run finds nothing left to re-encrypt', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    insertLegacyPlaintextSecret('MY_SECRET', 'leaked-secret-123456')

    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    expect(db.reencryptPlaintextFallbackRows().secrets).toBe(1)
    expect(db.reencryptPlaintextFallbackRows().secrets).toBe(0)
  })

  it('leaves an already-properly-encrypted row untouched', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    const secret = db.createSecret({ name: 'K', description: '', env_var_name: 'MY_SECRET', value: 'leaked-secret-123456' })!
    const before = (rawDb.prepare('SELECT value FROM secrets WHERE id = ?').get(secret.id) as { value: Buffer }).value

    expect(db.reencryptPlaintextFallbackRows().secrets).toBe(0)

    const after = (rawDb.prepare('SELECT value FROM secrets WHERE id = ?').get(secret.id) as { value: Buffer }).value
    expect(Buffer.compare(before, after)).toBe(0)
  })

  // P0, re-review: the OLD detection ("decrypt throws" => "plaintext") could
  // not tell "never encrypted" apart from "WAS encrypted, can't decrypt
  // right now for an unrelated reason" (keychain reset, keyring backend
  // changed, profile moved to another machine) — and would re-encrypt the
  // latter, permanently destroying the real ciphertext by overwriting it
  // with a UTF-8 misreading of its own bytes. The fix detects plaintext
  // POSITIVELY (byte prefix), so a real-but-undecryptable row must be left
  // alone entirely, not "fixed".
  it('does NOT touch a row that has the real encrypted-data prefix but fails to decrypt for an unrelated reason (keychain reset, etc.) — the exact scenario that used to destroy it', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    const secret = db.createSecret({ name: 'K', description: '', env_var_name: 'MY_SECRET', value: 'leaked-secret-123456' })!
    const originalBytes = (rawDb.prepare('SELECT value FROM secrets WHERE id = ?').get(secret.id) as { value: Buffer }).value
    expect(originalBytes.subarray(0, 3).toString('latin1')).toBe('v10') // sanity: really has the real prefix

    // Simulate "the OS can no longer decrypt this specific blob" (keychain
    // reset, etc.) WITHOUT changing its prefix — decryptString throws for
    // every v10-prefixed value for the rest of this test, same as it would
    // on a real system in this situation.
    vi.mocked(safeStorage.decryptString).mockImplementation(() => {
      throw new Error('simulated: OS keychain entry no longer decryptable')
    })

    const result = db.reencryptPlaintextFallbackRows()
    expect(result.secrets).toBe(0) // NOT treated as plaintext — left alone

    const afterBytes = (rawDb.prepare('SELECT value FROM secrets WHERE id = ?').get(secret.id) as { value: Buffer }).value
    expect(Buffer.compare(originalBytes, afterBytes)).toBe(0) // byte-for-byte untouched

    // Reading it back surfaces the failure rather than returning garbage —
    // and does not crash or corrupt anything for OTHER secrets in the batch.
    expect(db.getSecretsWithValues([secret.id])).toEqual([])
  })

  it('backs up the original bytes to disk before re-encrypting a genuinely legacy plaintext row', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const now = new Date().toISOString()
    rawDb.prepare(`
      INSERT INTO secrets (id, name, description, env_var_name, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('legacy-backup-1', 'Legacy', '', 'MY_SECRET', Buffer.from('leaked-secret-123456', 'utf8'), now, now)

    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    expect(existsSync(join(BACKUP_DIR, 'backup.jsonl'))).toBe(false)
    expect(db.reencryptPlaintextFallbackRows().secrets).toBe(1)

    const backupPath = join(BACKUP_DIR, 'backup.jsonl')
    expect(existsSync(backupPath)).toBe(true)
    const entry = JSON.parse(readFileSync(backupPath, 'utf-8').trim().split('\n')[0])
    expect(entry.table).toBe('secrets')
    expect(entry.id).toBe('legacy-backup-1')
    expect(Buffer.from(entry.original_base64, 'base64').toString('utf8')).toBe('leaked-secret-123456')
  })
})

describe('countPlaintextFallbackRows', () => {
  it('counts a legacy plaintext row regardless of whether encryption is currently available', () => {
    const now = new Date().toISOString()
    rawDb.prepare(`
      INSERT INTO secrets (id, name, description, env_var_name, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('legacy-count-1', 'Legacy', '', 'MY_SECRET', Buffer.from('leaked-secret-123456', 'utf8'), now, now)

    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    expect(db.countPlaintextFallbackRows()).toEqual({ secrets: 1, oauthTokens: 0 })

    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    expect(db.countPlaintextFallbackRows()).toEqual({ secrets: 1, oauthTokens: 0 })
  })

  it('does not count a properly-encrypted row, or a real-but-undecryptable one', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    db.createSecret({ name: 'K', description: '', env_var_name: 'MY_SECRET', value: 'leaked-secret-123456' })
    expect(db.countPlaintextFallbackRows()).toEqual({ secrets: 0, oauthTokens: 0 })

    vi.mocked(safeStorage.decryptString).mockImplementation(() => { throw new Error('simulated keychain failure') })
    expect(db.countPlaintextFallbackRows()).toEqual({ secrets: 0, oauthTokens: 0 }) // still has the real prefix — not plaintext
  })

  it('returns zero counts when there is nothing stored at all', () => {
    expect(db.countPlaintextFallbackRows()).toEqual({ secrets: 0, oauthTokens: 0 })
  })
})

describe('reading a legacy plaintext row never crashes, even once encryption is available', () => {
  it('getSecretsWithValues falls back to utf8 for a row that was never actually encrypted', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const now = new Date().toISOString()
    rawDb.prepare(`
      INSERT INTO secrets (id, name, description, env_var_name, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('legacy-1', 'Legacy', '', 'MY_SECRET', Buffer.from('leaked-secret-123456', 'utf8'), now, now)

    // Encryption is available NOW, but this row predates it.
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    expect(() => db.getSecretsWithValues(['legacy-1'])).not.toThrow()
    const [withValue] = db.getSecretsWithValues(['legacy-1'])
    expect(withValue.value).toBe('leaked-secret-123456')
  })
})
