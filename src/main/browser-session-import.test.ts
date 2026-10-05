import { afterEach, describe, expect, it } from 'vitest'
import { createCipheriv, createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { decryptChromiumCookie, normalizeDomains, parseSafariCookies, readChromium, readFirefox, shouldImportCookie } from './browser-session-import'

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('browser session import', () => {
  it('decrypts v10 and v11 CBC values and checks the domain binding', () => {
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const host = '.example.com'
    const plaintext = Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from('session-value')])
    const encrypt = (prefix: string) => {
      const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
      return Buffer.concat([Buffer.from(prefix), cipher.update(plaintext), cipher.final()])
    }
    expect(decryptChromiumCookie(encrypt('v10'), host, 24, { v10: key }, 'darwin')).toBe('session-value')
    expect(decryptChromiumCookie(encrypt('v11'), host, 24, { v11: key }, 'linux')).toBe('session-value')
    expect(decryptChromiumCookie(encrypt('v10'), '.other.com', 24, { v10: key }, 'darwin')).toBeNull()
    expect(decryptChromiumCookie(Buffer.from('v20other'), host, 24, { v10: key }, 'darwin')).toBeNull()
  })

  it('reads Firefox SQLite cookies and skips partitioned entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'browser-import-test-'))
    temporary.push(dir)
    const file = join(dir, 'cookies.sqlite')
    const db = new Database(file)
    db.exec('CREATE TABLE moz_cookies (host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, originAttributes TEXT)')
    db.prepare('INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('.example.com', 'sid', 'value', '/', 2000000000, 1, 1, 2, '')
    db.prepare('INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('.example.com', 'partitioned', 'value', '/', 2000000000, 1, 1, 2, 'partitionKey=%28https%2Cexample.com%29')
    db.close()
    const read = await readFirefox(file)
    expect(read.skipped).toBe(1)
    expect(read.cookies).toMatchObject([{ host: '.example.com', name: 'sid', value: 'value', secure: true, httpOnly: true, sameSite: 'strict' }])
  })

  it('converts Firefox schema 16 millisecond expiry to seconds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'browser-import-test-'))
    temporary.push(dir)
    const file = join(dir, 'cookies.sqlite')
    const db = new Database(file)
    db.pragma('user_version = 16')
    db.exec('CREATE TABLE moz_cookies (host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER)')
    db.prepare('INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('.example.com', 'sid', 'value', '/', 2000000000123, 1, 1, 1)
    db.close()
    expect((await readFirefox(file)).cookies[0].expirationDate).toBe(2000000000)
  })

  it('reports Windows app-bound cookies separately from other skipped rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'browser-import-test-'))
    temporary.push(dir)
    const file = join(dir, 'Cookies')
    const db = new Database(file)
    db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, top_frame_site_key TEXT)')
    db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('.example.com', 'sid', '', Buffer.from('v20sealed'), '/', 0, 1, 1, 1, '')
    db.close()
    expect(await readChromium(file, {}, 'win32')).toMatchObject({ cookies: [], skipped: 1, unsupportedWindowsCookies: 1 })
  })

  it('parses a small Safari binarycookies fixture', () => {
    const fields = ['.example.com', 'sid', '/', 'value']
    const record = Buffer.alloc(56 + fields.reduce((sum, field) => sum + Buffer.byteLength(field) + 1, 0))
    record.writeUInt32LE(record.length, 0)
    record.writeUInt32LE(5, 8)
    let offset = 56
    fields.forEach((field, index) => { record.writeUInt32LE(offset, 16 + index * 4); offset += record.write(field, offset, 'utf8'); record[offset++] = 0 })
    record.writeDoubleLE(2000000000 - 978307200, 40)
    const page = Buffer.alloc(16 + record.length)
    page.writeUInt32BE(0x100, 0)
    page.writeUInt32LE(1, 4)
    page.writeUInt32LE(16, 8)
    record.copy(page, 16)
    const jar = Buffer.alloc(12 + page.length)
    jar.write('cook', 0)
    jar.writeUInt32BE(1, 4)
    jar.writeUInt32BE(page.length, 8)
    page.copy(jar, 12)
    expect(parseSafariCookies(jar)).toMatchObject([{ host: '.example.com', name: 'sid', value: 'value', secure: true, httpOnly: true, expirationDate: 2000000000 }])
  })

  it('filters domains by label boundary and excludes expired cookies', () => {
    const cookie = { host: '.sub.example.com', name: 'sid', value: 'x', path: '/', secure: true, httpOnly: true, sameSite: 'lax' as const, expirationDate: 2000000000 }
    expect(shouldImportCookie(cookie, normalizeDomains(['example.com']), 1900000000)).toBe(true)
    expect(shouldImportCookie(cookie, normalizeDomains(['ample.com']), 1900000000)).toBe(false)
    expect(shouldImportCookie(cookie, [], 2100000000)).toBe(false)
    expect(() => normalizeDomains(['example.com/evil'])).toThrow()
  })
})
