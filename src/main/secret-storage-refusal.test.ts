import { describe, it, expect, beforeEach, vi } from 'vitest'
import { safeStorage } from 'electron'
import { createTestDb } from '../../test/helpers/db-test-helper'
import type { DatabaseManager } from './database'

let db: DatabaseManager
let rawDb: import('better-sqlite3').Database

// The global test mock (test/setup-main.ts) makes encryptString/decryptString
// an identity pass-through, which can't model the real asymmetry this file's
// tests depend on: a properly-encrypted blob is NOT valid input to decrypt as
// plaintext, and vice versa (real safeStorage prefixes encrypted output with
// a version marker; raw plaintext bytes don't have one, so decrypting them
// throws). Override with a fake pair that models that same asymmetry.
const MARKER = Buffer.from('FAKE_ENCRYPTED:')

beforeEach(() => {
  ;({ db, rawDb } = createTestDb())
  vi.mocked(safeStorage.encryptString).mockImplementation((value: string) => Buffer.concat([MARKER, Buffer.from(value, 'utf8')]))
  vi.mocked(safeStorage.decryptString).mockImplementation((buf: Buffer) => {
    if (!buf.subarray(0, MARKER.length).equals(MARKER)) throw new Error('not actually encrypted')
    return buf.subarray(MARKER.length).toString('utf8')
  })
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
