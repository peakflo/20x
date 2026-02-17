import Database from 'better-sqlite3'
import { app, safeStorage } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { createId } from '@paralleldrive/cuid2'
import { TaskStatus } from '../shared/constants'

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
  coding_agent?: 'opencode' | 'claude-code' | 'codex'
  model?: string
  system_prompt?: string
  mcp_servers?: Array<string | AgentMcpServerEntry>
  skill_ids?: string[]
  api_keys?: {
    openai?: string
    anthropic?: string
  }
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

export interface TaskSourceRow {
  id: string
  mcp_server_id: string | null
  name: string
  plugin_id: string
  config: string
  list_tool: string
  list_tool_args: string
  update_tool: string
  update_tool_args: string
  last_synced_at: string | null
  enabled: number
  created_at: string
  updated_at: string
}

export interface TaskSourceRecord {
  id: string
  mcp_server_id: string | null
  name: string
  plugin_id: string
  config: Record<string, unknown>
  list_tool: string
  list_tool_args: Record<string, unknown>
  update_tool: string
  update_tool_args: Record<string, unknown>
  last_synced_at: string | null
  enabled: boolean
  created_at: string
  updated_at: string
}

export interface CreateTaskSourceData {
  mcp_server_id: string | null
  name: string
  plugin_id: string
  config?: Record<string, unknown>
  list_tool?: string
  list_tool_args?: Record<string, unknown>
  update_tool?: string
  update_tool_args?: Record<string, unknown>
}

export interface UpdateTaskSourceData {
  name?: string
  plugin_id?: string
  config?: Record<string, unknown>
  mcp_server_id?: string
  list_tool?: string
  list_tool_args?: Record<string, unknown>
  update_tool?: string
  update_tool_args?: Record<string, unknown>
  enabled?: boolean
}

export interface OutputFieldRecord {
  id: string
  name: string
  type: string
  multiple?: boolean
  options?: string[]
  required?: boolean
  value?: unknown
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
  output_fields: string
  agent_id: string | null
  external_id: string | null
  source_id: string | null
  source: string
  skill_ids: string | null
  session_id: string | null
  snoozed_until: string | null
  resolution: string | null
  is_recurring: number
  recurrence_pattern: string | null
  recurrence_parent_id: string | null
  last_occurrence_at: string | null
  next_occurrence_at: string | null
  created_at: string
  updated_at: string
}

export interface RecurrencePatternRecord {
  type: 'daily' | 'weekly' | 'monthly' | 'custom'
  interval: number
  time: string
  weekdays?: number[]
  monthDay?: number
  endDate?: string
  maxOccurrences?: number
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
  attachments: FileAttachmentRecord[]
  repos: string[]
  output_fields: OutputFieldRecord[]
  agent_id: string | null
  external_id: string | null
  source_id: string | null
  source: string
  skill_ids: string[] | null
  session_id: string | null
  snoozed_until: string | null
  resolution: string | null
  is_recurring: boolean
  recurrence_pattern: RecurrencePatternRecord | null
  recurrence_parent_id: string | null
  last_occurrence_at: string | null
  next_occurrence_at: string | null
  created_at: string
  updated_at: string
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
  attachments?: FileAttachmentRecord[]
  repos?: string[]
  output_fields?: OutputFieldRecord[]
  external_id?: string
  source_id?: string
  source?: string
  is_recurring?: boolean
  recurrence_pattern?: RecurrencePatternRecord | null
  recurrence_parent_id?: string | null
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
  attachments?: FileAttachmentRecord[]
  repos?: string[]
  output_fields?: OutputFieldRecord[]
  agent_id?: string | null
  skill_ids?: string[] | null
  session_id?: string | null
  snoozed_until?: string | null
  is_recurring?: boolean
  recurrence_pattern?: RecurrencePatternRecord | null
  last_occurrence_at?: string | null
  next_occurrence_at?: string | null
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
  'attachments',
  'repos',
  'output_fields',
  'agent_id',
  'skill_ids',
  'session_id',
  'snoozed_until',
  'is_recurring',
  'recurrence_pattern',
  'last_occurrence_at',
  'next_occurrence_at'
])

const JSON_COLUMNS = new Set(['labels', 'attachments', 'repos', 'output_fields', 'skill_ids', 'recurrence_pattern'])

function deserializeTask(row: TaskRow): TaskRecord {
  return {
    ...row,
    labels: JSON.parse(row.labels) as string[],
    attachments: JSON.parse(row.attachments) as FileAttachmentRecord[],
    repos: JSON.parse(row.repos) as string[],
    output_fields: JSON.parse(row.output_fields || '[]') as OutputFieldRecord[],
    agent_id: row.agent_id ?? null,
    external_id: row.external_id ?? null,
    source_id: row.source_id ?? null,
    skill_ids: row.skill_ids ? JSON.parse(row.skill_ids) as string[] : null,
    session_id: row.session_id ?? null,
    snoozed_until: row.snoozed_until ?? null,
    resolution: row.resolution ?? null,
    is_recurring: row.is_recurring === 1,
    recurrence_pattern: row.recurrence_pattern ? JSON.parse(row.recurrence_pattern) as RecurrencePatternRecord : null,
    recurrence_parent_id: row.recurrence_parent_id ?? null,
    last_occurrence_at: row.last_occurrence_at ?? null,
    next_occurrence_at: row.next_occurrence_at ?? null
  }
}

function deserializeTaskSource(row: TaskSourceRow): TaskSourceRecord {
  try {
    return {
      ...row,
      plugin_id: row.plugin_id || 'peakflo',
      config: JSON.parse(row.config || '{}') as Record<string, unknown>,
      list_tool_args: JSON.parse(row.list_tool_args) as Record<string, unknown>,
      update_tool_args: JSON.parse(row.update_tool_args) as Record<string, unknown>,
      enabled: row.enabled === 1
    }
  } catch (err) {
    console.error('[Database] Failed to deserialize task source:', {
      id: row.id,
      name: row.name,
      config: row.config,
      list_tool_args: row.list_tool_args,
      update_tool_args: row.update_tool_args,
      error: err instanceof Error ? err.message : String(err)
    })
    throw err
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

// ── Skill types ───────────────────────────────────────────

export interface SkillRow {
  id: string
  name: string
  description: string
  content: string
  version: number
  confidence: number
  uses: number
  last_used: string | null
  tags: string
  is_deleted: number
  created_at: string
  updated_at: string
}

export interface SkillRecord {
  id: string
  name: string
  description: string
  content: string
  version: number
  confidence: number
  uses: number
  last_used: string | null
  tags: string[]
  created_at: string
  updated_at: string
}

export interface CreateSkillData {
  name: string
  description: string
  content: string
  confidence?: number
  uses?: number
  last_used?: string | null
  tags?: string[]
}

export interface UpdateSkillData {
  name?: string
  description?: string
  content?: string
  confidence?: number
  uses?: number
  last_used?: string | null
  tags?: string[]
}

// ── OAuth Token types ────────────────────────────────────────

export interface OAuthTokenRow {
  id: string
  provider: string
  source_id: string
  access_token: Buffer
  refresh_token: Buffer | null
  expires_at: string
  scope: string | null
  token_type: string
  created_at: string
  updated_at: string
}

export interface OAuthTokenRecord {
  id: string
  provider: string
  source_id: string
  access_token: string
  refresh_token: string | null
  expires_at: string
  scope: string | null
  token_type: string
  created_at: string
  updated_at: string
}

export interface CreateOAuthTokenData {
  provider: string
  source_id: string
  access_token: string
  refresh_token: string | null
  expires_in: number
  scope: string | null
}

function deserializeSkill(row: SkillRow): SkillRecord {
  let tags: string[] = []
  try {
    tags = JSON.parse(row.tags)
  } catch {
    tags = []
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    content: row.content,
    version: row.version,
    confidence: row.confidence,
    uses: row.uses,
    last_used: row.last_used,
    tags,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

function deserializeOAuthToken(row: OAuthTokenRow): OAuthTokenRecord {
  // Decrypt tokens using safeStorage
  const accessToken = safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(row.access_token)
    : row.access_token.toString('utf8')

  const refreshToken = row.refresh_token && safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(row.refresh_token)
    : row.refresh_token?.toString('utf8') || null

  return {
    id: row.id,
    provider: row.provider,
    source_id: row.source_id,
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: row.expires_at,
    scope: row.scope,
    token_type: row.token_type,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

export class DatabaseManager {
  public db!: Database.Database

  initialize(): void {
    const userDataPath = app.getPath('userData')
    const dbPath = join(userDataPath, 'pf-desktop.db')

    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')

    this.createTables()
    this.runMigrations()
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'general',
        priority TEXT NOT NULL DEFAULT 'medium',
        status TEXT NOT NULL DEFAULT '${TaskStatus.NotStarted}',
        assignee TEXT NOT NULL DEFAULT '',
        due_date TEXT,
        labels TEXT NOT NULL DEFAULT '[]',
        checklist TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'local',
        resolution TEXT,
        is_recurring INTEGER NOT NULL DEFAULT 0,
        recurrence_pattern TEXT DEFAULT NULL,
        recurrence_parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        last_occurrence_at TEXT DEFAULT NULL,
        next_occurrence_at TEXT DEFAULT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
      CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source);
      CREATE INDEX IF NOT EXISTS idx_tasks_next_occurrence ON tasks(next_occurrence_at) WHERE is_recurring = 1;

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

      CREATE TABLE IF NOT EXISTS task_sources (
        id TEXT PRIMARY KEY,
        mcp_server_id TEXT REFERENCES mcp_servers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        list_tool TEXT NOT NULL,
        list_tool_args TEXT NOT NULL DEFAULT '{}',
        update_tool TEXT NOT NULL DEFAULT '',
        update_tool_args TEXT NOT NULL DEFAULT '{}',
        last_synced_at TEXT,
        plugin_id TEXT NOT NULL DEFAULT 'peakflo',
        config TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        content TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        confidence REAL NOT NULL DEFAULT 0.5,
        uses INTEGER NOT NULL DEFAULT 0,
        last_used TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_tokens (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        source_id TEXT NOT NULL REFERENCES task_sources(id) ON DELETE CASCADE,
        access_token BLOB NOT NULL,
        refresh_token BLOB,
        expires_at TEXT NOT NULL,
        scope TEXT,
        token_type TEXT NOT NULL DEFAULT 'Bearer',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_source ON oauth_tokens(source_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider ON oauth_tokens(provider);
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

    if (!columnNames.has('output_fields')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN output_fields TEXT NOT NULL DEFAULT '[]'`)
    }

    if (!columnNames.has('external_id')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN external_id TEXT`)
    }
    if (!columnNames.has('source_id')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN source_id TEXT REFERENCES task_sources(id) ON DELETE SET NULL`)
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_external ON tasks(source_id, external_id) WHERE external_id IS NOT NULL`)
    }

    if (!columnNames.has('skill_ids')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN skill_ids TEXT DEFAULT NULL`)
    }

    // Migrate oc_session_id to session_id (for backward compatibility)
    if (columnNames.has('oc_session_id') && !columnNames.has('session_id')) {
      // Rename column by creating new column, copying data, dropping old
      this.db.exec(`ALTER TABLE tasks ADD COLUMN session_id TEXT DEFAULT NULL`)
      this.db.exec(`UPDATE tasks SET session_id = oc_session_id WHERE oc_session_id IS NOT NULL`)
      // Note: SQLite doesn't support DROP COLUMN in all versions, so we leave oc_session_id for now
      // It will be unused going forward
    } else if (!columnNames.has('session_id')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN session_id TEXT DEFAULT NULL`)
    }

    if (!columnNames.has('snoozed_until')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN snoozed_until TEXT DEFAULT NULL`)
    }

    if (!columnNames.has('resolution')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN resolution TEXT DEFAULT NULL`)
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

    // Migrate task_sources: add plugin_id + config columns
    const tsColumns = this.db.pragma('table_info(task_sources)') as { name: string }[]
    const tsColumnNames = new Set(tsColumns.map((c) => c.name))

    if (!tsColumnNames.has('plugin_id')) {
      this.db.exec(`ALTER TABLE task_sources ADD COLUMN plugin_id TEXT NOT NULL DEFAULT 'peakflo'`)
    }
    if (!tsColumnNames.has('config')) {
      this.db.exec(`ALTER TABLE task_sources ADD COLUMN config TEXT NOT NULL DEFAULT '{}'`)
      // Migrate existing rows: pack old columns into config JSON
      const sources = this.db.prepare('SELECT id, list_tool, list_tool_args, update_tool, update_tool_args FROM task_sources').all() as {
        id: string; list_tool: string; list_tool_args: string; update_tool: string; update_tool_args: string
      }[]
      for (const src of sources) {
        const config = {
          list_tool: src.list_tool,
          list_tool_args: JSON.parse(src.list_tool_args || '{}'),
          update_tool: src.update_tool || undefined,
          update_tool_args: JSON.parse(src.update_tool_args || '{}')
        }
        this.db.prepare('UPDATE task_sources SET config = ? WHERE id = ?').run(JSON.stringify(config), src.id)
      }
    }

    // Migrate task statuses: old 6-status → new 4-status
    const hasOldStatuses = (this.db.prepare(
      "SELECT COUNT(*) as count FROM tasks WHERE status IN ('inbox', 'accepted', 'in_progress', 'pending_review', 'cancelled')"
    ).get() as { count: number }).count > 0

    if (hasOldStatuses) {
      this.db.exec(`
        UPDATE tasks SET status = 'not_started' WHERE status IN ('inbox', 'accepted', 'cancelled');
        UPDATE tasks SET status = 'agent_working' WHERE status = 'in_progress';
        UPDATE tasks SET status = 'ready_for_review' WHERE status = 'pending_review';
      `)
    }

    // Add coding_agent column to agents table for multi-backend support
    const agentColumns = this.db.pragma('table_info(agents)') as { name: string }[]
    const agentColumnNames = new Set(agentColumns.map((c) => c.name))

    if (!agentColumnNames.has('coding_agent')) {
      this.db.exec(`ALTER TABLE agents ADD COLUMN coding_agent TEXT NOT NULL DEFAULT 'opencode'`)
      // Update existing agents to explicitly have 'opencode' as their coding_agent
      this.db.exec(`UPDATE agents SET coding_agent = 'opencode' WHERE coding_agent IS NULL OR coding_agent = ''`)
    }

    // Migrate task_sources: make mcp_server_id nullable (for plugins that don't need MCP)
    const tsInfo = this.db.pragma('table_info(task_sources)') as Array<{name: string, notnull: number}>
    const mcpServerIdCol = tsInfo.find(col => col.name === 'mcp_server_id')

    if (mcpServerIdCol && mcpServerIdCol.notnull === 1) {
      // Column exists and is NOT NULL, need to recreate table
      this.db.exec(`
        -- Disable foreign keys temporarily
        PRAGMA foreign_keys = OFF;

        -- Create new table with nullable mcp_server_id
        CREATE TABLE task_sources_new (
          id TEXT PRIMARY KEY,
          mcp_server_id TEXT REFERENCES mcp_servers(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          list_tool TEXT NOT NULL,
          list_tool_args TEXT NOT NULL DEFAULT '{}',
          update_tool TEXT NOT NULL DEFAULT '',
          update_tool_args TEXT NOT NULL DEFAULT '{}',
          last_synced_at TEXT,
          plugin_id TEXT NOT NULL DEFAULT 'peakflo',
          config TEXT NOT NULL DEFAULT '{}',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        -- Copy data
        INSERT INTO task_sources_new SELECT * FROM task_sources;

        -- Drop old table
        DROP TABLE task_sources;

        -- Rename new table
        ALTER TABLE task_sources_new RENAME TO task_sources;

        -- Re-enable foreign keys
        PRAGMA foreign_keys = ON;
      `)
    }

    // Fix corrupted task_sources config fields (cleanup after migration issues)
    const allSources = this.db.prepare('SELECT id, config, name FROM task_sources').all() as Array<{
      id: string
      config: string
      name: string
    }>

    for (const src of allSources) {
      try {
        // Try to parse config as JSON
        JSON.parse(src.config)
      } catch {
        // Invalid JSON - reset to empty object and set appropriate plugin_id
        console.log(`[Database Migration] Fixing corrupted config for task source: ${src.name} (${src.id})`)

        // Determine plugin_id based on name
        let pluginId = 'peakflo'
        if (src.name.toLowerCase().includes('linear')) {
          pluginId = 'linear'
        } else if (src.name.toLowerCase().includes('hubspot')) {
          pluginId = 'hubspot'
        }

        // Reset config to empty object and set plugin_id
        this.db.prepare('UPDATE task_sources SET config = ?, plugin_id = ? WHERE id = ?')
          .run('{}', pluginId, src.id)
      }
    }

    // Migrate tasks table: change source_id foreign key from ON DELETE SET NULL to ON DELETE CASCADE
    const taskTableInfo = this.db.pragma('foreign_key_list(tasks)') as Array<{
      id: number
      seq: number
      table: string
      from: string
      to: string
      on_update: string
      on_delete: string
    }>

    const sourceIdFk = taskTableInfo.find(fk => fk.from === 'source_id' && fk.table === 'task_sources')
    if (sourceIdFk && sourceIdFk.on_delete === 'SET NULL') {
      console.log('[Database Migration] Updating source_id foreign key to CASCADE delete')

      // Recreate tasks table with CASCADE delete for source_id
      this.db.exec(`
        PRAGMA foreign_keys = OFF;

        -- Create new tasks table with CASCADE delete
        CREATE TABLE tasks_new (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          type TEXT NOT NULL DEFAULT 'general',
          priority TEXT NOT NULL DEFAULT 'medium',
          status TEXT NOT NULL DEFAULT '${TaskStatus.NotStarted}',
          assignee TEXT NOT NULL DEFAULT '',
          due_date TEXT,
          labels TEXT NOT NULL DEFAULT '[]',
          checklist TEXT NOT NULL DEFAULT '[]',
          attachments TEXT NOT NULL DEFAULT '[]',
          repos TEXT NOT NULL DEFAULT '[]',
          output_fields TEXT NOT NULL DEFAULT '[]',
          agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          external_id TEXT,
          source_id TEXT REFERENCES task_sources(id) ON DELETE CASCADE,
          source TEXT NOT NULL DEFAULT 'local',
          skill_ids TEXT DEFAULT NULL,
          session_id TEXT DEFAULT NULL,
          snoozed_until TEXT DEFAULT NULL,
          resolution TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        -- Copy all data (handle both old and new schema columns)
        INSERT INTO tasks_new
        SELECT
          id, title, description, type, priority, status, assignee, due_date,
          labels, checklist,
          COALESCE(attachments, '[]'),
          COALESCE(repos, '[]'),
          COALESCE(output_fields, '[]'),
          agent_id,
          external_id,
          source_id,
          source,
          skill_ids,
          session_id,
          snoozed_until,
          resolution,
          created_at, updated_at
        FROM tasks;

        -- Drop old table
        DROP TABLE tasks;

        -- Rename new table
        ALTER TABLE tasks_new RENAME TO tasks;

        -- Recreate indexes
        CREATE INDEX idx_tasks_status ON tasks(status);
        CREATE INDEX idx_tasks_priority ON tasks(priority);
        CREATE INDEX idx_tasks_source ON tasks(source);
        CREATE UNIQUE INDEX idx_tasks_source_external ON tasks(source_id, external_id) WHERE external_id IS NOT NULL;

        PRAGMA foreign_keys = ON;
      `)

      console.log('[Database Migration] Successfully updated source_id foreign key to CASCADE')
    }

    // Add recurring task columns
    if (!columnNames.has('is_recurring')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN is_recurring INTEGER NOT NULL DEFAULT 0`)
    }
    if (!columnNames.has('recurrence_pattern')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN recurrence_pattern TEXT DEFAULT NULL`)
    }
    if (!columnNames.has('recurrence_parent_id')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN recurrence_parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE`)
    }
    if (!columnNames.has('last_occurrence_at')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN last_occurrence_at TEXT DEFAULT NULL`)
    }
    if (!columnNames.has('next_occurrence_at')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN next_occurrence_at TEXT DEFAULT NULL`)
      // Create index for efficient querying of recurring tasks
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_next_occurrence ON tasks(next_occurrence_at) WHERE is_recurring = 1`)
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

  private migrateInlineMcpServers(): void {
    const agents = this.db.prepare('SELECT id, config FROM agents').all() as { id: string; config: string }[]
    const now = new Date().toISOString()

    for (const agent of agents) {
      let config: any
      try { config = JSON.parse(agent.config) } catch { continue }

      if (!Array.isArray(config.mcp_servers) || config.mcp_servers.length === 0) continue
      // Already migrated if first element is a string (ID) or an AgentMcpServerEntry object
      const first = config.mcp_servers[0]
      if (typeof first === 'string' || (typeof first === 'object' && first.serverId)) continue

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

  getWorkspaceDir(taskId: string): string {
    const dir = join(app.getPath('userData'), 'workspaces', taskId)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
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
      INSERT INTO tasks (
        id, title, description, type, priority, status, assignee, due_date,
        labels, attachments, repos, output_fields, external_id, source_id, source,
        is_recurring, recurrence_pattern, recurrence_parent_id,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.title,
      data.description ?? '',
      data.type ?? 'general',
      data.priority ?? 'medium',
      data.status ?? TaskStatus.NotStarted,
      data.assignee ?? '',
      data.due_date ?? null,
      JSON.stringify(data.labels ?? []),
      JSON.stringify(data.attachments ?? []),
      JSON.stringify(data.repos ?? []),
      JSON.stringify(data.output_fields ?? []),
      data.external_id ?? null,
      data.source_id ?? null,
      data.source ?? 'local',
      data.is_recurring ? 1 : 0,
      data.recurrence_pattern ? JSON.stringify(data.recurrence_pattern) : null,
      data.recurrence_parent_id ?? null,
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

  // ── Task Source CRUD ─────────────────────────────────────────

  getTaskSources(): TaskSourceRecord[] {
    const rows = this.db.prepare('SELECT * FROM task_sources ORDER BY created_at ASC').all() as TaskSourceRow[]
    return rows.map(deserializeTaskSource)
  }

  getTaskSource(id: string): TaskSourceRecord | undefined {
    const row = this.db.prepare('SELECT * FROM task_sources WHERE id = ?').get(id) as TaskSourceRow | undefined
    return row ? deserializeTaskSource(row) : undefined
  }

  createTaskSource(data: CreateTaskSourceData): TaskSourceRecord | undefined {
    const id = createId()
    const now = new Date().toISOString()
    this.db.prepare(
      'INSERT INTO task_sources (id, mcp_server_id, name, plugin_id, config, list_tool, list_tool_args, update_tool, update_tool_args, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)'
    ).run(
      id,
      data.mcp_server_id,
      data.name,
      data.plugin_id || 'peakflo',
      JSON.stringify(data.config ?? {}),
      data.list_tool ?? '',
      JSON.stringify(data.list_tool_args ?? {}),
      data.update_tool ?? '',
      JSON.stringify(data.update_tool_args ?? {}),
      now,
      now
    )
    return this.getTaskSource(id)
  }

  updateTaskSource(id: string, data: UpdateTaskSourceData): TaskSourceRecord | undefined {
    const setClauses: string[] = []
    const values: (string | number | null)[] = []

    if (data.name !== undefined) { setClauses.push('name = ?'); values.push(data.name) }
    if (data.plugin_id !== undefined) { setClauses.push('plugin_id = ?'); values.push(data.plugin_id) }
    if (data.config !== undefined) {
      // IMPORTANT: Merge new config with existing config to preserve OAuth credentials
      const existing = this.getTaskSource(id)
      const mergedConfig = existing ? { ...existing.config, ...data.config } : data.config

      setClauses.push('config = ?')
      values.push(JSON.stringify(mergedConfig))
      // Reset last_synced_at when config changes (filters changed, need fresh sync)
      setClauses.push('last_synced_at = ?')
      values.push(null)
      console.log(`[Database] Resetting last_synced_at for task source ${id} due to config change`)
    }
    if (data.mcp_server_id !== undefined) { setClauses.push('mcp_server_id = ?'); values.push(data.mcp_server_id) }
    if (data.list_tool !== undefined) { setClauses.push('list_tool = ?'); values.push(data.list_tool) }
    if (data.list_tool_args !== undefined) { setClauses.push('list_tool_args = ?'); values.push(JSON.stringify(data.list_tool_args)) }
    if (data.update_tool !== undefined) { setClauses.push('update_tool = ?'); values.push(data.update_tool) }
    if (data.update_tool_args !== undefined) { setClauses.push('update_tool_args = ?'); values.push(JSON.stringify(data.update_tool_args)) }
    if (data.enabled !== undefined) { setClauses.push('enabled = ?'); values.push(data.enabled ? 1 : 0) }

    if (setClauses.length === 0) return this.getTaskSource(id)

    setClauses.push('updated_at = ?')
    values.push(new Date().toISOString())
    values.push(id)

    this.db.prepare(`UPDATE task_sources SET ${setClauses.join(', ')} WHERE id = ?`).run(...values)
    return this.getTaskSource(id)
  }

  updateTaskSourceLastSynced(id: string): void {
    this.db.prepare('UPDATE task_sources SET last_synced_at = ?, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), new Date().toISOString(), id)
  }

  deleteTaskSource(id: string): boolean {
    const result = this.db.prepare('DELETE FROM task_sources WHERE id = ?').run(id)
    return result.changes > 0
  }

  getTaskByExternalId(sourceId: string, externalId: string): TaskRecord | undefined {
    const row = this.db.prepare(
      'SELECT * FROM tasks WHERE source_id = ? AND external_id = ?'
    ).get(sourceId, externalId) as TaskRow | undefined
    return row ? deserializeTask(row) : undefined
  }

  // ── Skill CRUD ────────────────────────────────────────────

  getSkills(): SkillRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM skills WHERE is_deleted = 0 ORDER BY name ASC'
    ).all() as SkillRow[]
    return rows.map(deserializeSkill)
  }

  getSkill(id: string): SkillRecord | undefined {
    const row = this.db.prepare(
      'SELECT * FROM skills WHERE id = ? AND is_deleted = 0'
    ).get(id) as SkillRow | undefined
    return row ? deserializeSkill(row) : undefined
  }

  getSkillsByIds(ids: string[]): SkillRecord[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.db.prepare(
      `SELECT * FROM skills WHERE id IN (${placeholders}) AND is_deleted = 0 ORDER BY name ASC`
    ).all(...ids) as SkillRow[]
    return rows.map(deserializeSkill)
  }

  createSkill(data: CreateSkillData): SkillRecord | undefined {
    const id = createId()
    const now = new Date().toISOString()
    const confidence = data.confidence ?? 0.5
    const uses = data.uses ?? 0
    const lastUsed = data.last_used ?? null
    const tags = JSON.stringify(data.tags ?? [])
    this.db.prepare(`
      INSERT INTO skills (id, name, description, content, version, confidence, uses, last_used, tags, is_deleted, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, data.name, data.description, data.content, confidence, uses, lastUsed, tags, now, now)
    return this.getSkill(id)
  }

  updateSkill(id: string, data: UpdateSkillData): SkillRecord | undefined {
    const existing = this.getSkill(id)
    if (!existing) return undefined

    const setClauses: string[] = []
    const values: (string | number | null)[] = []

    if (data.name !== undefined) { setClauses.push('name = ?'); values.push(data.name) }
    if (data.description !== undefined) { setClauses.push('description = ?'); values.push(data.description) }
    if (data.content !== undefined) { setClauses.push('content = ?'); values.push(data.content) }
    if (data.confidence !== undefined) { setClauses.push('confidence = ?'); values.push(data.confidence) }
    if (data.uses !== undefined) { setClauses.push('uses = ?'); values.push(data.uses) }
    if (data.last_used !== undefined) { setClauses.push('last_used = ?'); values.push(data.last_used) }
    if (data.tags !== undefined) { setClauses.push('tags = ?'); values.push(JSON.stringify(data.tags)) }

    if (setClauses.length === 0) return existing

    // Increment version on any update
    setClauses.push('version = version + 1')
    setClauses.push('updated_at = ?')
    values.push(new Date().toISOString())
    values.push(id)

    this.db.prepare(
      `UPDATE skills SET ${setClauses.join(', ')} WHERE id = ?`
    ).run(...values)

    return this.getSkill(id)
  }

  getSkillByName(name: string): SkillRecord | undefined {
    const row = this.db.prepare(
      'SELECT * FROM skills WHERE name = ? AND is_deleted = 0'
    ).get(name) as SkillRow | undefined
    return row ? deserializeSkill(row) : undefined
  }

  deleteSkill(id: string): boolean {
    const result = this.db.prepare(
      'UPDATE skills SET is_deleted = 1, updated_at = ? WHERE id = ? AND is_deleted = 0'
    ).run(new Date().toISOString(), id)
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

  // ── OAuth Token CRUD ────────────────────────────────────────

  createOAuthToken(data: CreateOAuthTokenData): OAuthTokenRecord | undefined {
    const id = createId()
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString()

    // Encrypt tokens before storing
    const encryptedAccessToken = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(data.access_token)
      : Buffer.from(data.access_token, 'utf8')

    const encryptedRefreshToken = data.refresh_token && safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(data.refresh_token)
      : data.refresh_token ? Buffer.from(data.refresh_token, 'utf8') : null

    this.db.prepare(`
      INSERT INTO oauth_tokens (id, provider, source_id, access_token, refresh_token, expires_at, scope, token_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.provider,
      data.source_id,
      encryptedAccessToken,
      encryptedRefreshToken,
      expiresAt,
      data.scope,
      'Bearer',
      now,
      now
    )

    return this.getOAuthToken(id)
  }

  getOAuthToken(id: string): OAuthTokenRecord | undefined {
    const row = this.db.prepare(
      'SELECT * FROM oauth_tokens WHERE id = ?'
    ).get(id) as OAuthTokenRow | undefined

    return row ? deserializeOAuthToken(row) : undefined
  }

  getOAuthTokenBySource(sourceId: string): OAuthTokenRecord | undefined {
    const row = this.db.prepare(
      'SELECT * FROM oauth_tokens WHERE source_id = ?'
    ).get(sourceId) as OAuthTokenRow | undefined

    return row ? deserializeOAuthToken(row) : undefined
  }

  updateOAuthToken(id: string, accessToken: string, refreshToken: string | null, expiresIn: number): OAuthTokenRecord | undefined {
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()

    // Encrypt tokens before storing
    const encryptedAccessToken = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(accessToken)
      : Buffer.from(accessToken, 'utf8')

    const encryptedRefreshToken = refreshToken && safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(refreshToken)
      : refreshToken ? Buffer.from(refreshToken, 'utf8') : null

    this.db.prepare(
      'UPDATE oauth_tokens SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ? WHERE id = ?'
    ).run(encryptedAccessToken, encryptedRefreshToken, expiresAt, now, id)

    return this.getOAuthToken(id)
  }

  deleteOAuthToken(id: string): boolean {
    const result = this.db.prepare('DELETE FROM oauth_tokens WHERE id = ?').run(id)
    return result.changes > 0
  }

  deleteOAuthTokenBySource(sourceId: string): boolean {
    const result = this.db.prepare('DELETE FROM oauth_tokens WHERE source_id = ?').run(sourceId)
    return result.changes > 0
  }
}
