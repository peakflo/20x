import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { createId } from '@paralleldrive/cuid2'

export interface AgentRow {
  id: string
  name: string
  server_url: string
  config: string
  is_default: number
  created_at: string
  updated_at: string
}

export interface AgentRecord {
  id: string
  name: string
  server_url: string
  config: AgentConfigRecord
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface AgentMcpServerEntry {
  serverId: string
  enabledTools?: string[]
}

export interface AgentConfigRecord {
  model?: string
  system_prompt?: string
  mcp_servers?: Array<string | AgentMcpServerEntry>
}

export interface McpServerConfigRecord {
  name: string
  command: string
  args: string[]
}

export interface McpServerToolRecord {
  name: string
  description: string
}

export interface McpServerRow {
  id: string
  name: string
  type: string
  command: string
  args: string
  url: string | null
  headers: string
  environment: string
  tools: string
  created_at: string
  updated_at: string
}

export interface McpServerRecord {
  id: string
  name: string
  type: 'local' | 'remote'
  command: string
  args: string[]
  url: string
  headers: Record<string, string>
  environment: Record<string, string>
  tools: McpServerToolRecord[]
  created_at: string
  updated_at: string
}

export interface CreateMcpServerData {
  name: string
  type?: 'local' | 'remote'
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  environment?: Record<string, string>
}

export interface UpdateMcpServerData {
  name?: string
  type?: 'local' | 'remote'
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  environment?: Record<string, string>
}

export interface CreateAgentData {
  name: string
  server_url?: string
  config?: AgentConfigRecord
  is_default?: boolean
}

export interface UpdateAgentData {
  name?: string
  server_url?: string
  config?: AgentConfigRecord
  is_default?: boolean
}

export interface TaskRow {
  id: string
  title: string
  description: string
  type: string
  priority: string
  status: string
  assignee: string
  due_date: string | null
  labels: string
  checklist: string
  attachments: string
  repos: string
  agent_id: string | null
  source: string
  created_at: string
  updated_at: string
}

export interface TaskRecord {
  id: string
  title: string
  description: string
  type: string
  priority: string
  status: string
  assignee: string
  due_date: string | null
  labels: string[]
  checklist: ChecklistItemRecord[]
  attachments: FileAttachmentRecord[]
  repos: string[]
  agent_id: string | null
  source: string
  created_at: string
  updated_at: string
}

export interface ChecklistItemRecord {
  id: string
  text: string
  completed: boolean
}

export interface FileAttachmentRecord {
  id: string
  filename: string
  size: number
  mime_type: string
  added_at: string
}

export interface CreateTaskData {
  title: string
  description?: string
  type?: string
  priority?: string
  status?: string
  assignee?: string
  due_date?: string | null
  labels?: string[]
  checklist?: ChecklistItemRecord[]
  attachments?: FileAttachmentRecord[]
  repos?: string[]
}

export interface UpdateTaskData {
  title?: string
  description?: string
  type?: string
  priority?: string
  status?: string
  assignee?: string
  due_date?: string | null
  labels?: string[]
  checklist?: ChecklistItemRecord[]
  attachments?: FileAttachmentRecord[]
  repos?: string[]
  agent_id?: string | null
}

/** Columns that can be dynamically updated via updateTask. */
const UPDATABLE_COLUMNS = new Set([
  'title',
  'description',
  'type',
  'priority',
  'status',
  'assignee',
  'due_date',
  'labels',
  'checklist',
  'attachments',
  'repos',
  'agent_id'
])

const JSON_COLUMNS = new Set(['labels', 'checklist', 'attachments', 'repos'])

function deserializeTask(row: TaskRow): TaskRecord {
  return {
    ...row,
    labels: JSON.parse(row.labels) as string[],
    checklist: JSON.parse(row.checklist) as ChecklistItemRecord[],
    attachments: JSON.parse(row.attachments) as FileAttachmentRecord[],
    repos: JSON.parse(row.repos) as string[],
    agent_id: row.agent_id ?? null
  }
}

function deserializeMcpServer(row: McpServerRow): McpServerRecord {
  return {
    ...row,
    type: (row.type as 'local' | 'remote') || 'local',
    args: JSON.parse(row.args) as string[],
    url: row.url ?? '',
    headers: JSON.parse(row.headers || '{}') as Record<string, string>,
    environment: JSON.parse(row.environment || '{}') as Record<string, string>,
    tools: JSON.parse(row.tools || '[]') as McpServerToolRecord[]
  }
}

function deserializeAgent(row: AgentRow): AgentRecord {
  return {
    ...row,
    config: JSON.parse(row.config) as AgentConfigRecord,
    is_default: row.is_default === 1
  }
}

export class DatabaseManager {
  private db!: Database.Database

  initialize(): void {
    const userDataPath = app.getPath('userData')
    const dbPath = join(userDataPath, 'pf-desktop.db')

    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')

    this.createTables()
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'general',
        priority TEXT NOT NULL DEFAULT 'medium',
        status TEXT NOT NULL DEFAULT 'inbox',
        assignee TEXT NOT NULL DEFAULT '',
        due_date TEXT,
        labels TEXT NOT NULL DEFAULT '[]',
        checklist TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'local',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
      CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source);

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        server_url TEXT NOT NULL DEFAULT 'http://localhost:4096',
        config TEXT NOT NULL DEFAULT '{}',
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'local',
        command TEXT NOT NULL DEFAULT '',
        args TEXT NOT NULL DEFAULT '[]',
        url TEXT,
        headers TEXT NOT NULL DEFAULT '{}',
        environment TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)

    this.runMigrations()
  }

  private runMigrations(): void {
    const columns = this.db.pragma('table_info(tasks)') as { name: string }[]
    const columnNames = new Set(columns.map((c) => c.name))

    if (!columnNames.has('attachments')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'`)
    }

    if (!columnNames.has('agent_id')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL`)
    }

    if (!columnNames.has('repos')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN repos TEXT NOT NULL DEFAULT '[]'`)
    }

    // Migrate mcp_servers table — add new columns for remote support
    const mcpColumns = this.db.pragma('table_info(mcp_servers)') as { name: string }[]
    const mcpColumnNames = new Set(mcpColumns.map((c) => c.name))

    if (!mcpColumnNames.has('type')) {
      this.db.exec(`ALTER TABLE mcp_servers ADD COLUMN type TEXT NOT NULL DEFAULT 'local'`)
    }
    if (!mcpColumnNames.has('url')) {
      this.db.exec(`ALTER TABLE mcp_servers ADD COLUMN url TEXT`)
    }
    if (!mcpColumnNames.has('headers')) {
      this.db.exec(`ALTER TABLE mcp_servers ADD COLUMN headers TEXT NOT NULL DEFAULT '{}'`)
    }
    if (!mcpColumnNames.has('environment')) {
      this.db.exec(`ALTER TABLE mcp_servers ADD COLUMN environment TEXT NOT NULL DEFAULT '{}'`)
    }
    if (!mcpColumnNames.has('tools')) {
      this.db.exec(`ALTER TABLE mcp_servers ADD COLUMN tools TEXT NOT NULL DEFAULT '[]'`)
    }

    // Migrate inline MCP servers from agent configs → mcp_servers table
    this.migrateInlineMcpServers()

    // Seed default agent if none exist
    const agentCount = this.db.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number }
    if (agentCount.count === 0) {
      const now = new Date().toISOString()
      this.db.prepare(`
        INSERT INTO agents (id, name, server_url, config, is_default, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run(createId(), 'Default Agent', 'http://localhost:4096', '{}', now, now)
    }
  }

  private migrateInlineMcpServers(): void {
    const agents = this.db.prepare('SELECT id, config FROM agents').all() as { id: string; config: string }[]
    const now = new Date().toISOString()

    for (const agent of agents) {
      let config: any
      try { config = JSON.parse(agent.config) } catch { continue }

      if (!Array.isArray(config.mcp_servers) || config.mcp_servers.length === 0) continue
      // Already migrated if first element is a string (ID)
      if (typeof config.mcp_servers[0] === 'string') continue

      const ids: string[] = []
      for (const srv of config.mcp_servers as McpServerConfigRecord[]) {
        // Check if server with same name+command already exists
        const existing = this.db.prepare(
          'SELECT id FROM mcp_servers WHERE name = ? AND command = ?'
        ).get(srv.name, srv.command) as { id: string } | undefined

        if (existing) {
          ids.push(existing.id)
        } else {
          const id = createId()
          this.db.prepare(
            'INSERT INTO mcp_servers (id, name, command, args, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(id, srv.name, srv.command, JSON.stringify(srv.args || []), now, now)
          ids.push(id)
        }
      }

      config.mcp_servers = ids
      this.db.prepare('UPDATE agents SET config = ? WHERE id = ?').run(JSON.stringify(config), agent.id)
    }
  }

  getAttachmentsDir(taskId: string): string {
    const dir = join(app.getPath('userData'), 'attachments', taskId)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  deleteTaskAttachments(taskId: string): void {
    const dir = join(app.getPath('userData'), 'attachments', taskId)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }

  getTasks(): TaskRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM tasks ORDER BY created_at DESC'
    ).all() as TaskRow[]

    return rows.map(deserializeTask)
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.db.prepare(
      'SELECT * FROM tasks WHERE id = ?'
    ).get(id) as TaskRow | undefined

    return row ? deserializeTask(row) : undefined
  }

  createTask(data: CreateTaskData): TaskRecord | undefined {
    const id = createId()
    const now = new Date().toISOString()

    this.db.prepare(`
      INSERT INTO tasks (id, title, description, type, priority, status, assignee, due_date, labels, checklist, attachments, repos, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', ?, ?)
    `).run(
      id,
      data.title,
      data.description ?? '',
      data.type ?? 'general',
      data.priority ?? 'medium',
      data.status ?? 'inbox',
      data.assignee ?? '',
      data.due_date ?? null,
      JSON.stringify(data.labels ?? []),
      JSON.stringify(data.checklist ?? []),
      JSON.stringify(data.attachments ?? []),
      JSON.stringify(data.repos ?? []),
      now,
      now
    )

    return this.getTask(id)
  }

  updateTask(id: string, data: UpdateTaskData): TaskRecord | undefined {
    const setClauses: string[] = []
    const values: (string | null)[] = []

    for (const [key, value] of Object.entries(data)) {
      if (value === undefined || !UPDATABLE_COLUMNS.has(key)) continue

      setClauses.push(`${key} = ?`)
      if (JSON_COLUMNS.has(key)) {
        values.push(JSON.stringify(value))
      } else {
        values.push(value as string | null)
      }
    }

    if (setClauses.length === 0) return this.getTask(id)

    setClauses.push('updated_at = ?')
    values.push(new Date().toISOString())
    values.push(id)

    this.db.prepare(
      `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`
    ).run(...values)

    return this.getTask(id)
  }

  deleteTask(id: string): boolean {
    this.deleteTaskAttachments(id)
    const result = this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ── Agent CRUD ────────────────────────────────────────────

  getAgents(): AgentRecord[] {
    const rows = this.db.prepare('SELECT * FROM agents ORDER BY created_at ASC').all() as AgentRow[]
    return rows.map(deserializeAgent)
  }

  getAgent(id: string): AgentRecord | undefined {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined
    return row ? deserializeAgent(row) : undefined
  }

  createAgent(data: CreateAgentData): AgentRecord | undefined {
    const id = createId()
    const now = new Date().toISOString()

    this.db.prepare(`
      INSERT INTO agents (id, name, server_url, config, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.name,
      data.server_url ?? 'http://localhost:4096',
      JSON.stringify(data.config ?? {}),
      data.is_default ? 1 : 0,
      now,
      now
    )

    return this.getAgent(id)
  }

  updateAgent(id: string, data: UpdateAgentData): AgentRecord | undefined {
    const setClauses: string[] = []
    const values: (string | number | null)[] = []

    if (data.name !== undefined) {
      setClauses.push('name = ?')
      values.push(data.name)
    }
    if (data.server_url !== undefined) {
      setClauses.push('server_url = ?')
      values.push(data.server_url)
    }
    if (data.config !== undefined) {
      setClauses.push('config = ?')
      values.push(JSON.stringify(data.config))
    }
    if (data.is_default !== undefined) {
      setClauses.push('is_default = ?')
      values.push(data.is_default ? 1 : 0)
    }

    if (setClauses.length === 0) return this.getAgent(id)

    setClauses.push('updated_at = ?')
    values.push(new Date().toISOString())
    values.push(id)

    this.db.prepare(
      `UPDATE agents SET ${setClauses.join(', ')} WHERE id = ?`
    ).run(...values)

    return this.getAgent(id)
  }

  deleteAgent(id: string): boolean {
    const result = this.db.prepare('DELETE FROM agents WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ── MCP Server CRUD ────────────────────────────────────────

  getMcpServers(): McpServerRecord[] {
    const rows = this.db.prepare('SELECT * FROM mcp_servers ORDER BY created_at ASC').all() as McpServerRow[]
    return rows.map(deserializeMcpServer)
  }

  getMcpServer(id: string): McpServerRecord | undefined {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined
    return row ? deserializeMcpServer(row) : undefined
  }

  createMcpServer(data: CreateMcpServerData): McpServerRecord | undefined {
    const id = createId()
    const now = new Date().toISOString()
    const type = data.type ?? 'local'
    this.db.prepare(
      'INSERT INTO mcp_servers (id, name, type, command, args, url, headers, environment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id,
      data.name,
      type,
      data.command ?? '',
      JSON.stringify(data.args ?? []),
      data.url ?? null,
      JSON.stringify(data.headers ?? {}),
      JSON.stringify(data.environment ?? {}),
      now,
      now
    )
    return this.getMcpServer(id)
  }

  updateMcpServer(id: string, data: UpdateMcpServerData): McpServerRecord | undefined {
    const setClauses: string[] = []
    const values: (string | null)[] = []

    if (data.name !== undefined) { setClauses.push('name = ?'); values.push(data.name) }
    if (data.type !== undefined) { setClauses.push('type = ?'); values.push(data.type) }
    if (data.command !== undefined) { setClauses.push('command = ?'); values.push(data.command) }
    if (data.args !== undefined) { setClauses.push('args = ?'); values.push(JSON.stringify(data.args)) }
    if (data.url !== undefined) { setClauses.push('url = ?'); values.push(data.url || null) }
    if (data.headers !== undefined) { setClauses.push('headers = ?'); values.push(JSON.stringify(data.headers)) }
    if (data.environment !== undefined) { setClauses.push('environment = ?'); values.push(JSON.stringify(data.environment)) }

    if (setClauses.length === 0) return this.getMcpServer(id)

    setClauses.push('updated_at = ?')
    values.push(new Date().toISOString())
    values.push(id)

    this.db.prepare(`UPDATE mcp_servers SET ${setClauses.join(', ')} WHERE id = ?`).run(...values)
    return this.getMcpServer(id)
  }

  updateMcpServerTools(id: string, tools: McpServerToolRecord[]): void {
    this.db.prepare('UPDATE mcp_servers SET tools = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(tools), new Date().toISOString(), id)
  }

  deleteMcpServer(id: string): boolean {
    const result = this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ── Settings CRUD ──────────────────────────────────────────

  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }

  getAllSettings(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
    const result: Record<string, string> = {}
    for (const row of rows) result[row.key] = row.value
    return result
  }
}
