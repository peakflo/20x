import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { webContents } from 'electron'
import Database from 'better-sqlite3'
import type { BrowserImportRequest, BrowserImportResult, BrowserImportSource, BrowserSourceId } from '../shared/browser-session-import'
import { getAgentBrowserSession } from './agent-browser-session'

interface Cookie {
  host: string
  name: string
  value: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  expirationDate?: number
}

interface SourceDefinition {
  name: string
  mac?: string[]
  linux?: string[]
  windows?: string[]
  keychain?: [string, string]
  secretApplication?: string
}

const SOURCES: Record<BrowserSourceId, SourceDefinition> = {
  chrome: { name: 'Chrome', mac: ['Google', 'Chrome'], linux: ['google-chrome'], windows: ['Google', 'Chrome', 'User Data'], keychain: ['Chrome Safe Storage', 'Chrome'], secretApplication: 'chrome' },
  edge: { name: 'Microsoft Edge', mac: ['Microsoft Edge'], linux: ['microsoft-edge'], windows: ['Microsoft', 'Edge', 'User Data'], keychain: ['Microsoft Edge Safe Storage', 'Microsoft Edge'], secretApplication: 'msedge' },
  brave: { name: 'Brave', mac: ['BraveSoftware', 'Brave-Browser'], linux: ['BraveSoftware', 'Brave-Browser'], windows: ['BraveSoftware', 'Brave-Browser', 'User Data'], keychain: ['Brave Safe Storage', 'Brave'], secretApplication: 'brave' },
  arc: { name: 'Arc', mac: ['Arc', 'User Data'], keychain: ['Arc Safe Storage', 'Arc'] },
  firefox: { name: 'Firefox' },
  safari: { name: 'Safari' }
}

function sourceRoot(id: BrowserSourceId): string | null {
  if (id === 'firefox') {
    if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Firefox', 'Profiles')
    if (process.platform === 'win32') return join(process.env.APPDATA || '', 'Mozilla', 'Firefox', 'Profiles')
    return join(homedir(), '.mozilla', 'firefox')
  }
  if (id === 'safari') return process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Containers', 'com.apple.Safari', 'Data', 'Library', 'Cookies') : null
  const source = SOURCES[id]
  const parts = process.platform === 'darwin' ? source.mac : process.platform === 'win32' ? source.windows : source.linux
  if (!parts) return null
  const base = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : process.platform === 'win32' ? process.env.LOCALAPPDATA || ''
      : join(homedir(), '.config')
  return join(base, ...parts)
}

function cookieDatabase(root: string, id: BrowserSourceId, profile: string): string {
  if (id === 'safari') return join(root, 'Cookies.binarycookies')
  if (id === 'firefox') return join(root, profile, 'cookies.sqlite')
  const base = join(root, profile)
  const network = join(base, 'Network', 'Cookies')
  return existsSync(network) ? network : join(base, 'Cookies')
}

export function listBrowserImportSources(): BrowserImportSource[] {
  const result: BrowserImportSource[] = []
  for (const id of Object.keys(SOURCES) as BrowserSourceId[]) {
    const root = sourceRoot(id)
    if (!root || !existsSync(root)) continue
    let profiles: { id: string; name: string }[] = []
    if (id === 'safari') {
      if (existsSync(cookieDatabase(root, id, 'default'))) profiles = [{ id: 'default', name: 'Default' }]
    } else {
      for (const name of readdirSync(root)) {
        if (name.includes('/') || name.includes('\\') || name.startsWith('.')) continue
        if (id !== 'firefox' && name !== 'Default' && !/^Profile \d+$/.test(name)) continue
        if (existsSync(cookieDatabase(root, id, name))) profiles.push({ id: name, name })
      }
    }
    if (profiles.length) result.push({ id, name: SOURCES[id].name, profiles })
  }
  return result
}

const sameSite = (value: number): Cookie['sameSite'] => value === 0 ? 'no_restriction' : value === 1 ? 'lax' : value === 2 ? 'strict' : 'unspecified'
const derive = (secret: string, rounds: number) => pbkdf2Sync(secret, 'saltysalt', rounds, 16, 'sha1')

/** Returns null for schemes that this process cannot decrypt, including app-bound v20. */
export function decryptChromiumCookie(value: Buffer, host: string, schemaVersion: number, keys: { v10?: Buffer; v11?: Buffer; gcm?: Buffer }, platform: NodeJS.Platform = process.platform): string | null {
  if (!value.length) return ''
  const prefix = value.toString('latin1', 0, 3)
  let plain: Buffer
  try {
    if (platform === 'win32') {
      if (prefix !== 'v10' || !keys.gcm || value.length < 31) return null
      const nonce = value.subarray(3, 15)
      const tag = value.subarray(value.length - 16)
      const decryptor = createDecipheriv('aes-256-gcm', keys.gcm, nonce)
      decryptor.setAuthTag(tag)
      plain = Buffer.concat([decryptor.update(value.subarray(15, -16)), decryptor.final()])
    } else if (prefix === 'v10' || prefix === 'v11') {
      const key = prefix === 'v10' ? keys.v10 : keys.v11
      if (!key) return null
      const decryptor = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
      plain = Buffer.concat([decryptor.update(value.subarray(3)), decryptor.final()])
    } else {
      return prefix === 'v20' ? null : value.toString('utf8')
    }
    if (schemaVersion >= 24) {
      const hash = createHash('sha256').update(host).digest()
      if (plain.length < 32 || !plain.subarray(0, 32).equals(hash)) return null
      plain = plain.subarray(32)
    }
    return plain.toString('utf8')
  } catch { return null }
}

async function chromiumKeys(id: BrowserSourceId, root: string): Promise<{ v10?: Buffer; v11?: Buffer; gcm?: Buffer }> {
  if (process.platform === 'darwin') {
    const pair = SOURCES[id].keychain
    if (!pair) throw new Error('This browser has no supported Keychain item')
    const { Entry } = await import('@napi-rs/keyring')
    const secret = new Entry(pair[0], pair[1]).getPassword()
    if (!secret) throw new Error('Safe Storage key was unavailable or access was denied')
    return { v10: derive(secret, 1003), v11: derive(secret, 1003) }
  }
  if (process.platform === 'linux') {
    const keys: { v10?: Buffer; v11?: Buffer } = { v10: derive('peanuts', 1) }
    try {
      const secret = execFileSync('secret-tool', ['lookup', 'application', SOURCES[id].secretApplication || id], { encoding: 'utf8', timeout: 15000 }).trimEnd()
      if (secret) keys.v11 = derive(secret, 1)
    } catch { /* The v10 fallback remains available. */ }
    return keys
  }
  if (process.platform === 'win32') {
    const state = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8')) as { os_crypt?: { encrypted_key?: string } }
    const wrapped = Buffer.from(state.os_crypt?.encrypted_key || '', 'base64')
    if (wrapped.subarray(0, 5).toString() !== 'DPAPI') return {}
    const script = '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($p))'
    const encoded = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: wrapped.subarray(5).toString('base64'), encoding: 'utf8', timeout: 15000 })
    return { gcm: Buffer.from(encoded, 'base64') }
  }
  throw new Error('Unsupported platform')
}

async function sqliteRows<T>(path: string, sql: (db: Database.Database) => T): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), '20x-cookie-import-'))
  const temp = join(directory, 'snapshot.sqlite')
  let source: Database.Database | undefined
  try {
    chmodSync(directory, 0o700)
    source = new Database(path, { readonly: true, fileMustExist: true })
    await source.backup(temp)
    const snapshot = new Database(temp, { readonly: true })
    try { return sql(snapshot) } finally { snapshot.close() }
  } finally {
    source?.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

export async function readFirefox(path: string): Promise<{ cookies: Cookie[]; skipped: number }> {
  return sqliteRows(path, db => {
    const schemaVersion = Number((db.pragma('user_version', { simple: true }) as number) || 0)
    const columns = db.prepare('PRAGMA table_info(moz_cookies)').all() as { name: string }[]
    const has = (name: string) => columns.some(column => column.name === name)
    const rows = db.prepare(`SELECT host, name, value, path, expiry, isSecure, isHttpOnly, ${has('sameSite') ? 'sameSite' : '256 AS sameSite'}, ${has('originAttributes') ? 'originAttributes' : "'' AS originAttributes"} FROM moz_cookies`).all() as Array<{ host: string; name: string; value: string; path: string; expiry: number; isSecure: number; isHttpOnly: number; sameSite: number; originAttributes: string }>
    const cookies: Cookie[] = []
    let skipped = 0
    for (const row of rows) {
      if (row.originAttributes?.includes('partitionKey=')) { skipped++; continue }
      cookies.push({ host: row.host, name: row.name, value: row.value, path: row.path || '/', secure: !!row.isSecure, httpOnly: !!row.isHttpOnly, sameSite: sameSite(row.sameSite), expirationDate: row.expiry > 0 ? (schemaVersion >= 16 ? Math.floor(row.expiry / 1000) : row.expiry) : undefined })
    }
    return { cookies, skipped }
  })
}

export async function readChromium(path: string, keys: { v10?: Buffer; v11?: Buffer; gcm?: Buffer }, platform: NodeJS.Platform = process.platform): Promise<{ cookies: Cookie[]; skipped: number; unsupportedWindowsCookies: number }> {
  return sqliteRows(path, db => {
    let version = 23
    try { version = Number((db.prepare("SELECT value FROM meta WHERE key='version'").get() as { value: number } | undefined)?.value || 23) } catch { /* Older schema. */ }
    const columns = db.prepare('PRAGMA table_info(cookies)').all() as { name: string }[]
    const has = (name: string) => columns.some(column => column.name === name)
    const rows = db.prepare(`SELECT host_key, name, value, encrypted_value, path, expires_utc / 1000000 AS expires_seconds, is_secure, is_httponly, ${has('samesite') ? 'samesite' : '-1 AS samesite'}, ${has('top_frame_site_key') ? 'top_frame_site_key' : "'' AS top_frame_site_key"} FROM cookies`).all() as Array<{ host_key: string; name: string; value: string; encrypted_value: Buffer; path: string; expires_seconds: number; is_secure: number; is_httponly: number; samesite: number; top_frame_site_key: string }>
    const cookies: Cookie[] = []
    let skipped = 0
    let unsupportedWindowsCookies = 0
    for (const row of rows) {
      if (row.top_frame_site_key) { skipped++; continue }
      if (platform === 'win32' && row.encrypted_value?.subarray(0, 3).toString('latin1') === 'v20') { unsupportedWindowsCookies++; skipped++; continue }
      const value = row.encrypted_value?.length ? decryptChromiumCookie(row.encrypted_value, row.host_key, version, keys, platform) : row.value
      if (value === null) { skipped++; continue }
      cookies.push({ host: row.host_key, name: row.name, value, path: row.path || '/', secure: !!row.is_secure, httpOnly: !!row.is_httponly, sameSite: sameSite(row.samesite), expirationDate: row.expires_seconds > 0 ? row.expires_seconds - 11644473600 : undefined })
    }
    return { cookies, skipped, unsupportedWindowsCookies }
  })
}

const APPLE_EPOCH = 978307200
export function parseSafariCookies(data: Buffer): Cookie[] {
  if (data.length < 8 || data.toString('latin1', 0, 4) !== 'cook') throw new Error('Invalid Safari cookie file')
  const count = data.readUInt32BE(4)
  if (8 + count * 4 > data.length) throw new Error('Invalid Safari page table')
  const cookies: Cookie[] = []
  let start = 8 + count * 4
  for (let p = 0; p < count; p++) {
    const size = data.readUInt32BE(8 + p * 4)
    if (size < 12 || start + size > data.length) throw new Error('Invalid Safari page')
    const page = data.subarray(start, start + size)
    start += size
    const n = page.readUInt32LE(4)
    if (12 + n * 4 > page.length) throw new Error('Invalid Safari cookie offsets')
    const ranges: Array<[number, number]> = []
    for (let i = 0; i < n; i++) {
      const offset = page.readUInt32LE(8 + i * 4)
      if (offset < 12 + n * 4 || offset + 56 > page.length) throw new Error('Invalid Safari cookie record')
      const length = page.readUInt32LE(offset)
      if (length < 56 || offset + length > page.length) throw new Error('Invalid Safari cookie length')
      if (ranges.some(([begin, end]) => offset < end && offset + length > begin)) throw new Error('Overlapping Safari cookie records')
      ranges.push([offset, offset + length])
      const record = page.subarray(offset, offset + length)
      const string = (at: number): string => {
        if (at < 56 || at >= length) throw new Error('Invalid Safari cookie string')
        const end = record.indexOf(0, at)
        if (end < 0) throw new Error('Unterminated Safari cookie string')
        return record.toString('utf8', at, end)
      }
      const host = string(record.readUInt32LE(16))
      const name = string(record.readUInt32LE(20))
      if (!host || !name) continue
      const flags = record.readUInt32LE(8)
      const expiry = record.readDoubleLE(40)
      cookies.push({ host, name, path: string(record.readUInt32LE(24)) || '/', value: string(record.readUInt32LE(28)), secure: !!(flags & 1), httpOnly: !!(flags & 4), sameSite: 'lax', expirationDate: expiry > 0 ? Math.floor(expiry + APPLE_EPOCH) : undefined })
    }
  }
  const trailer = data.length - start
  if (trailer !== 0 && trailer !== 8 && !(trailer >= 12 && trailer === 12 + data.readUInt32BE(start + 8))) throw new Error('Invalid Safari cookie trailer')
  return cookies
}

export function normalizeDomains(domains: string[]): string[] {
  if (!Array.isArray(domains) || domains.length > 100) throw new Error('Invalid domain selection')
  return domains.map(domain => domain.trim().toLowerCase().replace(/^\./, '')).filter(Boolean).map(domain => {
    if (domain.length > 253 || !/^[a-z0-9.-]+$/.test(domain) || domain.startsWith('-') || domain.includes('..')) throw new Error('Invalid domain selection')
    return domain
  })
}

export function shouldImportCookie(cookie: Cookie, domains: string[], now = Date.now() / 1000): boolean {
  const host = cookie.host.replace(/^\./, '').toLowerCase()
  return !!host && (!cookie.expirationDate || cookie.expirationDate > now) && (!domains.length || domains.some(domain => host === domain || host.endsWith(`.${domain}`)))
}

export async function importBrowserSessions(input: BrowserImportRequest): Promise<BrowserImportResult> {
  const source = listBrowserImportSources().find(item => item.id === input?.browserId)
  if (!source || !source.profiles.some(profile => profile.id === input.profileId)) throw new Error('Select an available browser profile')
  const domains = normalizeDomains(input.domains)
  const root = sourceRoot(source.id)!
  const file = cookieDatabase(root, source.id, input.profileId)
  let read: { cookies: Cookie[]; skipped: number; unsupportedWindowsCookies?: number }
  if (source.id === 'safari') read = { cookies: parseSafariCookies(readFileSync(file)), skipped: 0 }
  else if (source.id === 'firefox') read = await readFirefox(file)
  else read = await readChromium(file, await chromiumKeys(source.id, root))
  const browserSession = getAgentBrowserSession()
  const byDomain: Record<string, number> = {}
  let skipped = read.skipped
  for (const cookie of read.cookies) {
    if (!shouldImportCookie(cookie, domains)) { skipped++; continue }
    const host = cookie.host.replace(/^\./, '').toLowerCase()
    const path = cookie.path.startsWith('/') ? cookie.path : '/'
    const url = `${cookie.secure ? 'https' : 'http'}://${host}${path}`
    const domain = cookie.host.startsWith('.') ? cookie.host : undefined
    try {
      await browserSession.cookies.set({ url, name: cookie.name, value: cookie.value, ...(domain ? { domain } : {}), path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, ...(cookie.expirationDate ? { expirationDate: cookie.expirationDate } : {}) })
      byDomain[host] = (byDomain[host] || 0) + 1
    } catch { skipped++ }
  }
  await browserSession.cookies.flushStore()
  return { imported: Object.values(byDomain).reduce((sum, count) => sum + count, 0), skipped, unsupportedWindowsCookies: read.unsupportedWindowsCookies || 0, byDomain }
}

export async function clearImportedBrowserSessions(): Promise<number> {
  const browserSession = getAgentBrowserSession()
  const count = (await browserSession.cookies.get({}).catch(() => [])).length
  // Close active pages first so their scripts cannot immediately renew a rotated session.
  for (const contents of webContents.getAllWebContents()) {
    if (contents.session === browserSession && !contents.isDestroyed()) {
      try { await contents.loadURL('about:blank') } catch { /* Continue clearing even if a page rejects navigation. */ }
    }
  }
  await browserSession.closeAllConnections()
  await browserSession.clearStorageData()
  await browserSession.clearCache()
  await browserSession.clearAuthCache()
  await browserSession.cookies.flushStore()
  return count
}
