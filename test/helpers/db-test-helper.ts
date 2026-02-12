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
  db.exec(`
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
      agent_id TEXT,
      external_id TEXT,
      source_id TEXT,
      source TEXT NOT NULL DEFAULT 'local',
      skill_ids TEXT DEFAULT NULL,
      oc_session_id TEXT DEFAULT NULL,
      snoozed_until TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
    CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_external ON tasks(source_id, external_id) WHERE external_id IS NOT NULL;

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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_sources (
      id TEXT PRIMARY KEY,
      mcp_server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
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

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      content TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)

  const manager = new DatabaseManager()

  // Inject the in-memory db into the private field
  ;(manager as any).db = db

  // Stub filesystem methods that call app.getPath
  manager.getWorkspaceDir = vi.fn(() => '/tmp/test-workspace')
  manager.getAttachmentsDir = vi.fn(() => '/tmp/test-attachments')
  manager.deleteTaskAttachments = vi.fn()

  return { db: manager, rawDb: db }
}
