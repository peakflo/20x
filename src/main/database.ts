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

export interface AgentConfigRecord {
  model?: string
  system_prompt?: string
  mcp_servers?: McpServerConfigRecord[]
}

export interface McpServerConfigRecord {
  name: string
  command: string
  args: string[]
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
  'agent_id'
])

const JSON_COLUMNS = new Set(['labels', 'checklist', 'attachments'])

function deserializeTask(row: TaskRow): TaskRecord {
  return {
    ...row,
    labels: JSON.parse(row.labels) as string[],
    checklist: JSON.parse(row.checklist) as ChecklistItemRecord[],
    attachments: JSON.parse(row.attachments) as FileAttachmentRecord[],
    agent_id: row.agent_id ?? null
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
      INSERT INTO tasks (id, title, description, type, priority, status, assignee, due_date, labels, checklist, attachments, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', ?, ?)
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
}
