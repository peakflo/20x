import Database from 'better-sqlite3'
import { vi } from 'vitest'
import { DatabaseManager } from '../../src/main/database'
import { TaskStatus } from '../../src/shared/constants'

/**
 * Creates a DatabaseManager backed by in-memory SQLite for testing.
 * We cannot use the real `initialize()` because it calls `app.getPath()`.
 * Instead, we inject the DB instance directly and create tables manually.
 */
export function createTestDb(): { db: DatabaseManager; rawDb: InstanceType<typeof Database> } {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Create tables (mirrors DatabaseManager.createTables — full schema)
  // Note: Create tables in dependency order to satisfy foreign key constraints
  db.exec(`
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
      tools TEXT NOT NULL DEFAULT '[]',
      oauth_metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_sources (
      id TEXT PRIMARY KEY,
      mcp_server_id TEXT REFERENCES mcp_servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      plugin_id TEXT NOT NULL DEFAULT 'peakflo',
      config TEXT NOT NULL DEFAULT '{}',
      list_tool TEXT NOT NULL DEFAULT '',
      list_tool_args TEXT NOT NULL DEFAULT '{}',
      update_tool TEXT NOT NULL DEFAULT '',
      update_tool_args TEXT NOT NULL DEFAULT '{}',
      last_synced_at TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

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
      attachments TEXT NOT NULL DEFAULT '[]',
      repos TEXT NOT NULL DEFAULT '[]',
      output_fields TEXT NOT NULL DEFAULT '[]',
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      external_id TEXT,
      source_id TEXT REFERENCES task_sources(id) ON DELETE CASCADE,
      source TEXT NOT NULL DEFAULT 'local',
      skill_ids TEXT DEFAULT NULL,
      oc_session_id TEXT DEFAULT NULL,
      session_id TEXT DEFAULT NULL,
      snoozed_until TEXT DEFAULT NULL,
      resolution TEXT,
      feedback_rating INTEGER DEFAULT NULL,
      feedback_comment TEXT DEFAULT NULL,
      is_recurring INTEGER NOT NULL DEFAULT 0,
      recurrence_pattern TEXT DEFAULT NULL,
      recurrence_parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      last_occurrence_at TEXT DEFAULT NULL,
      next_occurrence_at TEXT DEFAULT NULL,
      parent_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
    CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_external ON tasks(source_id, external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tasks_next_occurrence ON tasks(next_occurrence_at) WHERE is_recurring = 1;

    -- FTS5 full-text search index for similar task search
    CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
      title,
      description,
      labels,
      type,
      content='tasks',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS tasks_fts_insert AFTER INSERT ON tasks BEGIN
      INSERT INTO tasks_fts(rowid, title, description, labels, type)
        VALUES (new.rowid, new.title, new.description, new.labels, new.type);
    END;

    CREATE TRIGGER IF NOT EXISTS tasks_fts_update AFTER UPDATE OF title, description, labels, type ON tasks BEGIN
      INSERT INTO tasks_fts(tasks_fts, rowid, title, description, labels, type)
        VALUES ('delete', old.rowid, old.title, old.description, old.labels, old.type);
      INSERT INTO tasks_fts(rowid, title, description, labels, type)
        VALUES (new.rowid, new.title, new.description, new.labels, new.type);
    END;

    CREATE TRIGGER IF NOT EXISTS tasks_fts_delete AFTER DELETE ON tasks BEGIN
      INSERT INTO tasks_fts(tasks_fts, rowid, title, description, labels, type)
        VALUES ('delete', old.rowid, old.title, old.description, old.labels, old.type);
    END;

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
      enterprise_skill_id TEXT DEFAULT NULL,
      uses_at_last_sync INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      source_id TEXT REFERENCES task_sources(id) ON DELETE CASCADE,
      mcp_server_id TEXT REFERENCES mcp_servers(id) ON DELETE CASCADE,
      access_token BLOB NOT NULL,
      refresh_token BLOB,
      expires_at TEXT NOT NULL,
      scope TEXT,
      token_type TEXT NOT NULL DEFAULT 'Bearer',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_oauth_tokens_source ON oauth_tokens(source_id);
    CREATE INDEX IF NOT EXISTS idx_oauth_tokens_mcp_server ON oauth_tokens(mcp_server_id);
    CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider ON oauth_tokens(provider);

    CREATE TABLE IF NOT EXISTS marketplace_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      source_type TEXT NOT NULL DEFAULT 'github',
      source_url TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      auto_update INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS installed_plugins (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      marketplace_id TEXT REFERENCES marketplace_sources(id) ON DELETE CASCADE,
      manifest TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT '{}',
      scope TEXT NOT NULL DEFAULT 'user',
      enabled INTEGER NOT NULL DEFAULT 1,
      version TEXT NOT NULL DEFAULT '1.0.0',
      installed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_installed_plugins_name_marketplace
      ON installed_plugins(name, marketplace_id);
  `)

  const manager = new DatabaseManager()

  // Inject the in-memory db into the private field
  manager.db = db

  // Stub filesystem methods that call app.getPath
  manager.getWorkspaceDir = vi.fn(() => '/tmp/test-workspace')
  manager.getAttachmentsDir = vi.fn(() => '/tmp/test-attachments')
  manager.deleteTaskAttachments = vi.fn()

  return { db: manager, rawDb: db }
}
