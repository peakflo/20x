import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { safeStorage } from 'electron'
import { existsSync, readFileSync, readdirSync, rmSync } from 'fs'
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

// XOR-obfuscated, not a readable prefix+plaintext concatenation — round-trip
// correct (XOR twice = identity) but, unlike plain ASCII text, essentially
// never valid UTF-8 on its own (verified: every non-empty test fixture
// value in this file fails isValidUtf8 once XORed). Re-review (round 3,
// P2): `isPlaintextFallback` now requires an ACTUAL decrypt success before
// trusting the v10/v11 prefix alone (a plaintext secret whose value happens
// to start with "v10"/"v11" would otherwise be misclassified as real
// ciphertext forever) — which falls back to the SAME isValidUtf8 check the
// no-prefix path already used. A mock that produces plain-ASCII "encrypted"
// bytes would trivially pass that UTF-8 check and defeat the very test below
// (P0) that checks a real-but-undecryptable row is left alone, not
// mistaken for plaintext.
function obfuscate(buf: Buffer): Buffer {
  return Buffer.from(buf.map((b) => b ^ 0xff))
}

// Stands in for what a real AEAD cipher's authentication tag guarantees:
// decrypting bytes that were never genuinely produced by `encryptString`
// MUST fail, not silently "succeed" with garbage. Without this, a row whose
// plaintext VALUE just happens to start with "v10" (prefix + arbitrary text
// right after it) would decrypt "successfully" under a naive mock — the
// mock would deobfuscate whatever bytes follow the prefix and return THAT
// as a string, with no failure signal — even though those bytes were never
// actually encrypted. A real safeStorage/os_crypt decrypt call authenticates
// the ciphertext and throws for exactly this case; this magic marker makes
// the mock do the same.
const AEAD_MAGIC = Buffer.from('FAKEAEADTAG', 'latin1')

beforeEach(() => {
  ;({ db, rawDb } = createTestDb())
  vi.mocked(safeStorage.encryptString).mockImplementation((value: string) =>
    Buffer.concat([REAL_PREFIX, AEAD_MAGIC, obfuscate(Buffer.from(value, 'utf8'))])
  )
  vi.mocked(safeStorage.decryptString).mockImplementation((buf: Buffer) => {
    if (!buf.subarray(0, REAL_PREFIX.length).equals(REAL_PREFIX)) throw new Error('not actually encrypted')
    const afterPrefix = buf.subarray(REAL_PREFIX.length)
    if (!afterPrefix.subarray(0, AEAD_MAGIC.length).equals(AEAD_MAGIC)) {
      throw new Error('authentication failed — not genuinely encrypted data (simulated AEAD tag check)')
    }
    return obfuscate(afterPrefix.subarray(AEAD_MAGIC.length)).toString('utf8')
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

  // P2, re-review (round 3): the OTHER direction of the same ambiguity —
  // a genuinely plaintext secret whose VALUE happens to start with the
  // literal characters "v10" (coincidence, not encryption) used to be
  // misclassified as real ciphertext on the prefix bytes alone, then left
  // permanently unreadable (every future decrypt attempt throws, and it
  // was never even counted/warned about as a plaintext row). The prefix
  // alone is no longer trusted — an actual decrypt attempt must succeed
  // first.
  it('recovers a genuinely plaintext row whose VALUE happens to start with "v10" (prefix collision, not encryption)', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const now = new Date().toISOString()
    const coincidentalValue = 'v10-my-passphrase-not-actually-encrypted'
    rawDb.prepare(`
      INSERT INTO secrets (id, name, description, env_var_name, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('legacy-prefix-collision', 'Legacy', '', 'MY_SECRET', Buffer.from(coincidentalValue, 'utf8'), now, now)

    // Sanity: this row really does start with the real safeStorage prefix
    // bytes, purely because of what the plaintext VALUE happens to be.
    const stored = (rawDb.prepare('SELECT value FROM secrets WHERE id = ?').get('legacy-prefix-collision') as { value: Buffer }).value
    expect(stored.subarray(0, 3).toString('latin1')).toBe('v10')

    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    expect(db.countPlaintextFallbackRows().secrets).toBe(1) // correctly identified, not silently ignored
    expect(db.reencryptPlaintextFallbackRows().secrets).toBe(1)

    // Now genuinely, properly encrypted — and reads back correctly.
    const [withValue] = db.getSecretsWithValues(['legacy-prefix-collision'])
    expect(withValue.value).toBe(coincidentalValue)
  })

  // P1, re-review (round 3): the backup used to be appended to one shared
  // `backup.jsonl` that NOTHING ever trimmed — despite a comment claiming
  // "these are never real secrets," every plaintext row's real secret
  // value sat there in base64 forever. Each row now gets its OWN backup
  // file, which this test intercepts mid-migration (before the UPDATE
  // commits) to prove it genuinely existed and held the right bytes — and
  // the next test proves it's still there right after the migration
  // finishes (round 4: backups now outlive the run that created them, on
  // purpose — see cleanupPriorReencryptBackups's docstring — and are only
  // swept up at the START of the NEXT run).
  it('backs up the original bytes to disk before re-encrypting a genuinely legacy plaintext row', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const now = new Date().toISOString()
    rawDb.prepare(`
      INSERT INTO secrets (id, name, description, env_var_name, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('legacy-backup-1', 'Legacy', '', 'MY_SECRET', Buffer.from('leaked-secret-123456', 'utf8'), now, now)

    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    expect(existsSync(BACKUP_DIR)).toBe(false)

    // backupBeforeReencrypt runs BEFORE safeStorage.encryptString, which
    // runs BEFORE the UPDATE that would make the backup file redundant —
    // so wrapping encryptString is a clean place to observe the file
    // while it still exists, without reaching into private methods.
    let backupContentsAtEncryptTime: string | undefined
    const realEncryptString = vi.mocked(safeStorage.encryptString).getMockImplementation()!
    vi.mocked(safeStorage.encryptString).mockImplementation((value: string) => {
      const files = existsSync(BACKUP_DIR) ? readdirSync(BACKUP_DIR) : []
      const backupFile = files.find((f) => f.startsWith('secrets-legacy-backup-1-value-'))
      if (backupFile) backupContentsAtEncryptTime = readFileSync(join(BACKUP_DIR, backupFile), 'utf-8')
      return realEncryptString(value)
    })

    expect(db.reencryptPlaintextFallbackRows().secrets).toBe(1)

    expect(backupContentsAtEncryptTime).toBeDefined()
    expect(Buffer.from(backupContentsAtEncryptTime!, 'base64').toString('utf8')).toBe('leaked-secret-123456')
  })

  // Round 4, residual-risk fix: a backup is NOT deleted at the end of the
  // same run that created it — a mistaken re-encrypt (see
  // cleanupPriorReencryptBackups's docstring for the scenario: a real,
  // currently-undecryptable ciphertext row whose bytes coincidentally pass
  // the UTF-8 fallback check) needs at least one full restart's worth of
  // time to be noticed before its only backup disappears.
  it('keeps the backup file on disk after the migration that created it completes (deliberately, not a leak — see round 4)', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const now = new Date().toISOString()
    rawDb.prepare(`
      INSERT INTO secrets (id, name, description, env_var_name, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('legacy-backup-2', 'Legacy', '', 'MY_SECRET', Buffer.from('leaked-secret-123456', 'utf8'), now, now)

    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    expect(db.reencryptPlaintextFallbackRows().secrets).toBe(1)

    expect(existsSync(BACKUP_DIR)).toBe(true)
    const files = readdirSync(BACKUP_DIR)
    expect(files.some((f) => f.startsWith('secrets-legacy-backup-2-value-'))).toBe(true)
  })

  // P1, re-review (round 3, still honored): the backup from a PRIOR run is
  // swept away at the start of the NEXT run — so it doesn't accumulate
  // forever, just survives one extra restart's worth of time compared to
  // the immediate-delete version (round 4 tightened the timing, not the
  // "eventually cleaned up" guarantee).
  it('sweeps up a PRIOR run\'s backup at the start of the next run, once nothing from that run still needs it', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const now = new Date().toISOString()
    rawDb.prepare(`
      INSERT INTO secrets (id, name, description, env_var_name, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('legacy-backup-3', 'Legacy', '', 'MY_SECRET', Buffer.from('leaked-secret-123456', 'utf8'), now, now)

    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    expect(db.reencryptPlaintextFallbackRows().secrets).toBe(1) // "run 1" — leaves its backup behind
    expect(existsSync(BACKUP_DIR)).toBe(true)

    expect(db.reencryptPlaintextFallbackRows().secrets).toBe(0) // "run 2" (next app start) — nothing new to do
    // Run 1's leftover backup is swept up at the START of run 2, and run 2
    // itself created none (idempotent — the row is already encrypted).
    expect(existsSync(BACKUP_DIR)).toBe(false)
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
