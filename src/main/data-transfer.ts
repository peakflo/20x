/**
 * Export and import of the user's 20x data.
 *
 * A bundle is a gzipped tar (`.20x`) holding:
 *
 *   manifest.json                 format, versions, categories, row counts
 *   tables/<table>.json           every exported row of that table
 *   attachments/<taskId>/<file>   task attachment files
 *
 * Rules the format keeps:
 *
 * - Secrets never leave the machine. Secret values, OAuth tokens, enterprise
 *   and mobile tokens, agent API keys, and credential-looking fields in MCP
 *   server and task source configs are dropped or blanked on export. Secrets are
 *   exported by name and env var only, and arrive empty for the user to refill.
 * - Import merges. It never deletes or overwrites a row, except settings, which
 *   the user ticked to restore. A row whose id already exists is skipped.
 * - Records every install seeds with a random id (the default agent, the
 *   Mastermind skill, MCP servers) are matched by name instead, and references
 *   to them are pointed at the existing row.
 * - Columns are copied by name, so a bundle from an older or newer schema
 *   imports: missing columns take their defaults and unknown ones are ignored.
 */

import { createReadStream, createWriteStream, existsSync } from 'fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'fs/promises'
import { dirname, join, posix } from 'path'
import { pipeline } from 'stream/promises'
import { createGunzip, createGzip } from 'zlib'
import { extract as tarExtract, pack as tarPack } from 'tar-stream'
import type Database from 'better-sqlite3'
import {
  DATA_CATEGORIES,
  type BundleManifest,
  type DataCategory,
  type DataImportResult as ImportResult,
  type TableImportStats
} from '../shared/data-transfer'

export { DATA_CATEGORIES }
export type { BundleManifest, DataCategory, ImportResult, TableImportStats }

export const BUNDLE_FORMAT = '20x-export'
export const BUNDLE_VERSION = 1
export const BUNDLE_EXTENSION = '20x'

/** Hard ceilings so a hostile or corrupt bundle cannot exhaust memory. */
const MAX_ENTRY_BYTES = 512 * 1024 * 1024
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024

/** Tables per category. Within a category, parent tables come first. */
const CATEGORY_TABLES: Record<DataCategory, readonly string[]> = {
  mcp: ['mcp_servers', 'task_sources'],
  skills: ['skills'],
  secrets: ['secrets'],
  agents: ['agents'],
  plugins: ['marketplace_sources', 'installed_plugins'],
  settings: ['settings'],
  tasks: ['tasks', 'heartbeat_logs'],
  transcripts: ['transcript_parts']
}

const IMPORT_ORDER: readonly DataCategory[] = [
  'mcp',
  'skills',
  'secrets',
  'agents',
  'plugins',
  'settings',
  'tasks',
  'transcripts'
]

export interface ExportResult {
  path: string
  manifest: BundleManifest
}

type Row = Record<string, unknown>

// ── Redaction ────────────────────────────────────────────────────────────────

/** Key names whose values are credentials. Matched anywhere in the key. */
const SENSITIVE_KEY = /(secret|token|password|passwd|api[_-]?key|apikey|credential|authorization|private[_-]?key|cookie|bearer|session[_-]?key)/i

/** Settings that are credentials, belong to this machine, or are internal. */
const LOCAL_SETTING = /^(enterprise_|mobile_|__)|^(OPENCODE_BINARY_PATH|workspace_autocleanup_last_run)$/

/** The built-in MCP server points at this install's own files. */
const BUILT_IN_MCP_SERVER = 'task-management'

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key)
}

/**
 * Returns a copy of `value` with credential-looking keys removed. A string under
 * such a key is kept as `''` so the user can see what to fill in again; any
 * other value under it (an object of keys, a number) is dropped.
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      if (typeof inner === 'string') out[key] = ''
      continue
    }
    out[key] = redactSecrets(inner)
  }
  return out
}

function redactJsonColumn(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw === '') return raw
  try {
    return JSON.stringify(redactSecrets(JSON.parse(raw)))
  } catch {
    return raw
  }
}

/** Columns holding JSON that may carry credentials, per table. */
const REDACTED_JSON_COLUMNS: Record<string, readonly string[]> = {
  agents: ['config'],
  mcp_servers: ['headers', 'environment'],
  task_sources: ['config', 'list_tool_args', 'update_tool_args']
}

export function isExportableSetting(key: string): boolean {
  return !LOCAL_SETTING.test(key) && !isSensitiveKey(key)
}

/** Makes one table's rows safe to write into a bundle. */
export function sanitizeRows(table: string, rows: Row[]): Row[] {
  if (table === 'settings') {
    return rows.filter((row) => isExportableSetting(String(row.key)))
  }
  if (table === 'mcp_servers') {
    rows = rows.filter((row) => row.name !== BUILT_IN_MCP_SERVER)
  }
  return rows.map((row) => {
    const out: Row = { ...row }
    for (const column of REDACTED_JSON_COLUMNS[table] ?? []) {
      if (column in out) out[column] = redactJsonColumn(out[column])
    }
    if (table === 'mcp_servers' && 'oauth_metadata' in out) out.oauth_metadata = '{}'
    if (table === 'secrets') delete out.value
    for (const [column, value] of Object.entries(out)) {
      // Anything binary left over is encrypted with this machine's key.
      if (Buffer.isBuffer(value) || value instanceof Uint8Array) delete out[column]
    }
    return out
  })
}

// ── Export ───────────────────────────────────────────────────────────────────

function tableExists(db: Database.Database, table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
}

function readTable(db: Database.Database, table: string): Row[] {
  if (!tableExists(db, table)) return []
  return db.prepare(`SELECT * FROM "${table}"`).all() as Row[]
}

async function listAttachmentFiles(userDataDir: string, taskIds: string[]): Promise<string[]> {
  const files: string[] = []
  for (const taskId of taskIds) {
    const dir = join(userDataDir, 'attachments', taskId)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const info = await stat(join(dir, name)).catch(() => null)
      if (info?.isFile()) files.push(posix.join(taskId, name))
    }
  }
  return files
}

export interface ExportOptions {
  db: Database.Database
  userDataDir: string
  outPath: string
  categories: DataCategory[]
  appVersion: string
  schemaVersion: number
}

export async function exportBundle(options: ExportOptions): Promise<ExportResult> {
  const { db, userDataDir, outPath, appVersion, schemaVersion } = options
  const categories = DATA_CATEGORIES.filter((c) => options.categories.includes(c))
  if (categories.length === 0) throw new Error('Pick at least one kind of data to export')

  const tables = new Map<string, Row[]>()
  for (const category of categories) {
    for (const table of CATEGORY_TABLES[category]) {
      tables.set(table, sanitizeRows(table, readTable(db, table)))
    }
  }

  const taskIds = (tables.get('tasks') ?? []).map((row) => String(row.id))
  const attachmentFiles = categories.includes('tasks')
    ? await listAttachmentFiles(userDataDir, taskIds)
    : []

  const counts: Record<string, number> = {}
  for (const [table, rows] of tables) counts[table] = rows.length
  counts.attachments = attachmentFiles.length

  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    appVersion,
    schemaVersion,
    exportedAt: new Date().toISOString(),
    categories,
    counts
  }

  const pack = tarPack()
  const written = pipeline(pack, createGzip(), createWriteStream(outPath))

  const addEntry = (name: string, body: Buffer | string): Promise<void> =>
    new Promise((resolve, reject) => {
      pack.entry({ name, mtime: new Date() }, body, (err) => (err ? reject(err) : resolve()))
    })

  try {
    await addEntry('manifest.json', JSON.stringify(manifest, null, 2))
    for (const [table, rows] of tables) {
      await addEntry(`tables/${table}.json`, JSON.stringify(rows))
    }
    for (const relative of attachmentFiles) {
      const body = await readFile(join(userDataDir, 'attachments', ...relative.split('/')))
      await addEntry(`attachments/${relative}`, body)
    }
    pack.finalize()
  } catch (err) {
    pack.destroy(err as Error)
    await written.catch(() => {})
    throw err
  }
  await written

  return { path: outPath, manifest }
}

// ── Reading a bundle ─────────────────────────────────────────────────────────

export interface ParsedBundle {
  manifest: BundleManifest
  tables: Map<string, Row[]>
  /** Attachment files keyed by `<taskId>/<file name>`. */
  attachments: Map<string, Buffer>
}

/**
 * Accepts only the entry names this format writes, so a crafted bundle cannot
 * write outside the attachments folder (`../`, absolute paths, drive letters).
 */
const TABLE_ENTRY = /^tables\/([a-z_]+)\.json$/
const ATTACHMENT_ENTRY = /^attachments\/([A-Za-z0-9_-]+)\/([^/\\]+)$/

function isSafeFileName(name: string): boolean {
  return name !== '.' && name !== '..' && !name.includes('\0') && !/[<>:"|?*]/.test(name)
}

export async function readBundle(path: string): Promise<ParsedBundle> {
  const extract = tarExtract()
  const entries = new Map<string, Buffer>()
  let total = 0

  extract.on('entry', (header, stream, next) => {
    const chunks: Buffer[] = []
    let size = 0
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length
      total += chunk.length
      if (size > MAX_ENTRY_BYTES || total > MAX_BUNDLE_BYTES) {
        stream.destroy(new Error('This export file is too large to import'))
        return
      }
      chunks.push(chunk)
    })
    stream.on('error', (err: Error) => extract.destroy(err))
    stream.on('end', () => {
      if (header.type === 'file' || header.type == null) {
        entries.set(header.name, Buffer.concat(chunks))
      }
      next()
    })
  })

  try {
    await pipeline(createReadStream(path), createGunzip(), extract)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('too large')) throw err
    throw new Error('This file is not a 20x export, or it is damaged')
  }

  const manifestRaw = entries.get('manifest.json')
  if (!manifestRaw) throw new Error('This file is not a 20x export, or it is damaged')
  let manifest: BundleManifest
  try {
    manifest = JSON.parse(manifestRaw.toString('utf8'))
  } catch {
    throw new Error('This file is not a 20x export, or it is damaged')
  }
  if (manifest?.format !== BUNDLE_FORMAT) throw new Error('This file is not a 20x export')
  if (typeof manifest.version !== 'number' || manifest.version > BUNDLE_VERSION) {
    throw new Error('This export was made by a newer version of 20x. Update 20x and try again.')
  }

  const tables = new Map<string, Row[]>()
  const attachments = new Map<string, Buffer>()
  for (const [name, body] of entries) {
    const table = TABLE_ENTRY.exec(name)
    if (table) {
      const rows = JSON.parse(body.toString('utf8'))
      if (Array.isArray(rows)) tables.set(table[1], rows.filter((r) => r && typeof r === 'object'))
      continue
    }
    const attachment = ATTACHMENT_ENTRY.exec(name)
    if (attachment && isSafeFileName(attachment[2])) {
      attachments.set(`${attachment[1]}/${attachment[2]}`, body)
    }
  }

  return { manifest, tables, attachments }
}

/** Categories present in a bundle, with the number of rows in each. */
export function summarizeBundle(bundle: ParsedBundle): Partial<Record<DataCategory, number>> {
  const summary: Partial<Record<DataCategory, number>> = {}
  for (const category of DATA_CATEGORIES) {
    const [main] = CATEGORY_TABLES[category]
    const rows = bundle.tables.get(main)
    if (rows) summary[category] = rows.length
  }
  return summary
}

// ── Import ───────────────────────────────────────────────────────────────────

interface ColumnInfo {
  name: string
  notnull: number
  dflt_value: unknown
  pk: number
}

function tableColumns(db: Database.Database, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info("${table}")`).all() as ColumnInfo[]
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/**
 * Maps ids in the bundle to existing ids for records matched by a natural key.
 * Rows with a mapped id are not inserted; references to them are rewritten.
 */
interface IdMaps {
  agents: Map<string, string>
  skills: Map<string, string>
  mcpServers: Map<string, string>
  secrets: Map<string, string>
}

function buildIdMap(
  db: Database.Database,
  rows: Row[] | undefined,
  table: string,
  keyColumn: string,
  where = ''
): Map<string, string> {
  const map = new Map<string, string>()
  if (!rows?.length || !tableExists(db, table)) return map
  const existing = new Map<string, string>()
  for (const row of db.prepare(`SELECT id, "${keyColumn}" AS k FROM "${table}" ${where}`).all() as Array<{ id: string; k: unknown }>) {
    existing.set(String(row.k), row.id)
  }
  for (const row of rows) {
    const id = String(row.id)
    const match = existing.get(String(row[keyColumn]))
    if (match && match !== id) map.set(id, match)
  }
  return map
}

function remapList(list: unknown, map: Map<string, string>): unknown {
  if (!Array.isArray(list) || map.size === 0) return list
  return list.map((id) => (typeof id === 'string' ? (map.get(id) ?? id) : id))
}

/** Rewrites references inside rows to the ids they were matched to. */
export function remapReferences(table: string, row: Row, maps: IdMaps): Row {
  const out = { ...row }
  const swap = (map: Map<string, string>, column: string): void => {
    const value = out[column]
    if (typeof value === 'string' && map.has(value)) out[column] = map.get(value)
  }

  if (table === 'tasks') {
    swap(maps.agents, 'agent_id')
    if (typeof out.skill_ids === 'string') {
      const ids = parseJson<unknown>(out.skill_ids, null)
      if (Array.isArray(ids)) out.skill_ids = JSON.stringify(remapList(ids, maps.skills))
    }
  } else if (table === 'task_sources') {
    swap(maps.mcpServers, 'mcp_server_id')
  } else if (table === 'agents') {
    const config = parseJson<Record<string, unknown> | null>(out.config, null)
    if (config) {
      config.skill_ids = remapList(config.skill_ids, maps.skills)
      config.secret_ids = remapList(config.secret_ids, maps.secrets)
      if (Array.isArray(config.mcp_servers)) {
        config.mcp_servers = config.mcp_servers.map((entry) => {
          if (typeof entry === 'string') return maps.mcpServers.get(entry) ?? entry
          if (entry && typeof entry === 'object' && typeof (entry as Row).serverId === 'string') {
            const serverId = (entry as Row).serverId as string
            return { ...(entry as Row), serverId: maps.mcpServers.get(serverId) ?? serverId }
          }
          return entry
        })
      }
      for (const key of Object.keys(config)) if (config[key] === undefined) delete config[key]
      out.config = JSON.stringify(config)
    }
  } else if (table === 'settings') {
    swap(maps.agents, 'value')
  }
  return out
}

/**
 * Clears references to rows that do not exist after the import, for example a
 * task whose agent was not imported. A nullable reference is set to NULL and a
 * row whose required parent is missing is removed. Only the imported tables are
 * checked, so unrelated existing data is never touched.
 */
function repairForeignKeys(db: Database.Database, tables: string[]): void {
  for (let pass = 0; pass < 5; pass++) {
    let fixed = 0
    for (const table of tables) {
      const violations = db.prepare(`PRAGMA foreign_key_check("${table}")`).all() as Array<{ rowid: number; fkid: number }>
      if (violations.length === 0) continue
      const fks = db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{ id: number; from: string }>
      const notNull = new Set(tableColumns(db, table).filter((c) => c.notnull).map((c) => c.name))
      for (const violation of violations) {
        const column = fks.find((fk) => fk.id === violation.fkid)?.from
        if (column && !notNull.has(column)) {
          db.prepare(`UPDATE "${table}" SET "${column}" = NULL WHERE rowid = ?`).run(violation.rowid)
        } else {
          db.prepare(`DELETE FROM "${table}" WHERE rowid = ?`).run(violation.rowid)
        }
        fixed++
      }
    }
    if (fixed === 0) return
  }
}

export interface ImportOptions {
  db: Database.Database
  userDataDir: string
  bundle: ParsedBundle
  categories: DataCategory[]
  /** Encrypts `''` with this machine's key, for secrets that arrive empty. */
  encryptEmptySecret: () => Buffer
  /** Called once before anything is written. Returns the backup path. */
  backup?: () => Promise<string | null>
}

export async function importBundle(options: ImportOptions): Promise<ImportResult> {
  const { db, userDataDir, bundle } = options
  const categories = IMPORT_ORDER.filter(
    (c) => options.categories.includes(c) && bundle.manifest.categories.includes(c)
  )
  if (categories.length === 0) throw new Error('Pick at least one kind of data to import')

  const backupPath = options.backup ? await options.backup() : null

  const maps: IdMaps = {
    agents: categories.includes('agents') ? buildIdMap(db, bundle.tables.get('agents'), 'agents', 'name') : new Map(),
    skills: categories.includes('skills')
      ? buildIdMap(db, bundle.tables.get('skills'), 'skills', 'name', 'WHERE is_deleted = 0')
      : new Map(),
    mcpServers: categories.includes('mcp') ? buildIdMap(db, bundle.tables.get('mcp_servers'), 'mcp_servers', 'name') : new Map(),
    secrets: categories.includes('secrets') ? buildIdMap(db, bundle.tables.get('secrets'), 'secrets', 'env_var_name') : new Map()
  }
  const matchedIds: Record<string, Map<string, string>> = {
    agents: maps.agents,
    skills: maps.skills,
    mcp_servers: maps.mcpServers,
    secrets: maps.secrets
  }

  const result: ImportResult = { tables: {}, attachments: 0, secretsNeedingValues: [], backupPath }
  const insertedTaskIds = new Set<string>()
  const touchedTables: string[] = []
  const hadDefaultAgent = tableExists(db, 'agents') && !!db.prepare('SELECT 1 FROM agents WHERE is_default = 1').get()

  const run = db.transaction(() => {
    for (const category of categories) {
      for (const table of CATEGORY_TABLES[category]) {
        const rows = bundle.tables.get(table)
        if (!rows || !tableExists(db, table)) continue
        touchedTables.push(table)

        const columns = tableColumns(db, table)
        const known = new Set(columns.map((c) => c.name))
        const stats: TableImportStats = { inserted: 0, skipped: 0, failed: 0 }
        result.tables[table] = stats
        const matched = matchedIds[table]
        let nextRev = table === 'transcript_parts'
          ? (db.prepare('SELECT COALESCE(MAX(rev), 0) AS m FROM transcript_parts').get() as { m: number }).m
          : 0

        for (const source of rows) {
          if (table === 'settings' && !isExportableSetting(String(source.key))) {
            stats.skipped++
            continue
          }
          if (table === 'mcp_servers' && source.name === BUILT_IN_MCP_SERVER) {
            stats.skipped++
            continue
          }
          if (matched?.has(String(source.id))) {
            stats.skipped++
            continue
          }

          const row = remapReferences(table, source, maps)
          if (table === 'secrets') row.value = options.encryptEmptySecret()
          if (table === 'agents' && hadDefaultAgent) row.is_default = 0
          if (table === 'transcript_parts') row.rev = ++nextRev

          const names = Object.keys(row).filter((name) => known.has(name))
          if (names.length === 0) {
            stats.failed++
            continue
          }
          const values = names.map((name) => {
            const value = row[name]
            if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value)) return JSON.stringify(value)
            if (typeof value === 'boolean') return value ? 1 : 0
            return value
          })
          // Settings are preferences the user chose to restore, so they replace
          // the current value. Everything else is only ever added.
          const verb = table === 'settings' ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE'
          const sql = `${verb} INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`
          try {
            const info = db.prepare(sql).run(...values)
            if (info.changes > 0) {
              stats.inserted++
              if (table === 'tasks') insertedTaskIds.add(String(row.id))
              if (table === 'secrets') result.secretsNeedingValues.push(String(row.env_var_name))
            } else {
              stats.skipped++
            }
          } catch (err) {
            console.warn(`[DataTransfer] Could not import a ${table} row:`, err)
            stats.failed++
          }
        }
      }
    }
    repairForeignKeys(db, touchedTables)
  })

  // Rows are inserted with foreign keys off so the order of parents and
  // children inside a table does not matter; repairForeignKeys() cleans up.
  // The pragma is a no-op inside a transaction, so it is switched outside.
  const foreignKeys = db.pragma('foreign_keys', { simple: true }) as number
  db.pragma('foreign_keys = OFF')
  try {
    run()
  } finally {
    if (foreignKeys) db.pragma('foreign_keys = ON')
  }

  if (categories.includes('tasks')) {
    for (const [relative, body] of bundle.attachments) {
      const [taskId, name] = relative.split('/')
      if (!insertedTaskIds.has(taskId)) continue
      const target = join(userDataDir, 'attachments', taskId, name)
      if (existsSync(target)) continue
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, body)
      result.attachments++
    }
  }

  return result
}
