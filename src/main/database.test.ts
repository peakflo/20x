import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import RawDatabase from 'better-sqlite3'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeTask, makeAgent, makeSkill } from '../../test/helpers/task-fixtures'
import { DatabaseManager as RealDatabaseManager, type DatabaseManager } from './database'

let db: DatabaseManager

beforeEach(() => {
  ;({ db } = createTestDb())
})

describe('Task CRUD', () => {
  it('creates and retrieves a task', () => {
    const task = db.createTask(makeTask({ title: 'Hello World' }))
    expect(task).toBeDefined()
    expect(task!.title).toBe('Hello World')
    expect(task!.id).toBeTruthy()

    const fetched = db.getTask(task!.id)
    expect(fetched).toEqual(task)
  })

  it('returns all tasks', () => {
    db.createTask(makeTask({ title: 'Task 1' }))
    db.createTask(makeTask({ title: 'Task 2' }))
    const tasks = db.getTasks()
    expect(tasks).toHaveLength(2)
  })

  it('updates a task', () => {
    const task = db.createTask(makeTask())!
    const updated = db.updateTask(task.id, { title: 'Updated Title', priority: 'high' })
    expect(updated!.title).toBe('Updated Title')
    expect(updated!.priority).toBe('high')
  })

  it('updates task resolution', () => {
    const task = db.createTask(makeTask())!
    const updated = db.updateTask(task.id, { resolution: 'Fixed by adding a regression test.' })

    expect(updated!.resolution).toBe('Fixed by adding a regression test.')
    expect(db.getTask(task.id)!.resolution).toBe('Fixed by adding a regression test.')
  })

  it('clears task resolution', () => {
    const task = db.createTask(makeTask())!
    db.updateTask(task.id, { resolution: 'No longer needed.' })

    const updated = db.updateTask(task.id, { resolution: null })

    expect(updated!.resolution).toBeNull()
    expect(db.getTask(task.id)!.resolution).toBeNull()
  })

  it('does not update non-updatable fields', () => {
    const task = db.createTask(makeTask())!
    const updated = db.updateTask(task.id, { title: 'New' } as unknown as Parameters<typeof db.updateTask>[1])
    expect(updated!.title).toBe('New')
    // source is not in UPDATABLE_COLUMNS
    expect(updated!.source).toBe('local')
  })

  it('returns existing task when no update data provided', () => {
    const task = db.createTask(makeTask())!
    const same = db.updateTask(task.id, {})
    expect(same!.id).toBe(task.id)
  })

  it('deletes a task', () => {
    const task = db.createTask(makeTask())!
    const result = db.deleteTask(task.id)
    expect(result).toBe(true)
    expect(db.getTask(task.id)).toBeUndefined()
  })

  it('returns false when deleting non-existent task', () => {
    expect(db.deleteTask('non-existent')).toBe(false)
  })

  it('getByExternalId finds the right task', () => {
    // First create an MCP server for the foreign key
    const server = db.createMcpServer({ name: 'Test Server' })!
    const source = db.createTaskSource({
      mcp_server_id: server.id,
      name: 'Test Source',
      plugin_id: 'peakflo'
    })!

    db.createTask(makeTask({
      title: 'External Task',
      external_id: 'ext-123',
      source_id: source.id,
      source: 'Test Source'
    }))

    const found = db.getTaskByExternalId(source.id, 'ext-123')
    expect(found).toBeDefined()
    expect(found!.title).toBe('External Task')
    expect(found!.external_id).toBe('ext-123')
  })

  it('returns undefined for non-existent external_id', () => {
    expect(db.getTaskByExternalId('src', 'nope')).toBeUndefined()
  })
})

describe('JSON deserialization', () => {
  it('deserializes labels as string[]', () => {
    const task = db.createTask(makeTask({ labels: ['bug', 'urgent'] }))!
    expect(task.labels).toEqual(['bug', 'urgent'])
  })

  it('deserializes attachments as objects', () => {
    const attachments = [{
      id: 'a1',
      filename: 'doc.pdf',
      size: 1024,
      mime_type: 'application/pdf',
      added_at: '2024-01-01T00:00:00Z'
    }]
    const task = db.createTask(makeTask({ attachments }))!
    expect(task.attachments).toEqual(attachments)
  })

  it('deserializes repos as string[]', () => {
    const task = db.createTask(makeTask({ repos: ['owner/repo1'] }))!
    expect(task.repos).toEqual(['owner/repo1'])
  })

  it('deserializes double-stringified repos safely as array', () => {
    // Simulate corrupted data: repos stored as double-stringified JSON
    const task = db.createTask(makeTask({ repos: ['owner/repo1'] }))!
    const rawDb = (db as unknown as { db: import('better-sqlite3').Database }).db
    // Write a double-stringified value directly to the database
    rawDb.prepare('UPDATE tasks SET repos = ? WHERE id = ?')
      .run(JSON.stringify(JSON.stringify(['owner/repo1'])), task.id)
    const reloaded = db.getTask(task.id)!
    expect(Array.isArray(reloaded.repos)).toBe(true)
    // The double-stringified value becomes a string after one parse;
    // ensureArray wraps it into an array
    expect(reloaded.repos).toEqual(['["owner/repo1"]'])
  })

  it('deserializes scalar string repos safely as array', () => {
    const task = db.createTask(makeTask())!
    const rawDb = (db as unknown as { db: import('better-sqlite3').Database }).db
    // Write a scalar string value (not an array) to the repos column
    rawDb.prepare('UPDATE tasks SET repos = ? WHERE id = ?')
      .run(JSON.stringify('owner/repo1'), task.id)
    const reloaded = db.getTask(task.id)!
    expect(Array.isArray(reloaded.repos)).toBe(true)
    expect(reloaded.repos).toEqual(['owner/repo1'])
  })

  it('deserializes output_fields as objects', () => {
    const outputFields = [{ id: 'f1', name: 'Result', type: 'text' }]
    const task = db.createTask(makeTask({ output_fields: outputFields }))!
    expect(task.output_fields).toEqual(outputFields)
  })

  it('handles null skill_ids', () => {
    const task = db.createTask(makeTask())!
    expect(task.skill_ids).toBeNull()
  })
})

describe('getHeartbeatDueTasks', () => {
  function dueNow(task: { id: string }) {
    db.updateTask(task.id, {
      heartbeat_enabled: true,
      heartbeat_next_check_at: new Date(Date.now() - 60_000).toISOString()
    })
  }

  it('excludes a ready_for_review subtask whose parent task is completed', () => {
    const parent = db.createTask(makeTask({ title: 'Parent', status: 'completed' }))!
    const subtask = db.createTask(makeTask({ title: 'Subtask', status: 'ready_for_review', parent_task_id: parent.id }))!
    // Simulate a flag left by a version before the completed-parent guard.
    const rawDb = (db as unknown as { db: import('better-sqlite3').Database }).db
    rawDb.prepare('UPDATE tasks SET heartbeat_enabled = 1, heartbeat_next_check_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), subtask.id)

    expect(db.getHeartbeatDueTasks().map(t => t.id)).not.toContain(subtask.id)
  })

  it('clears a task and its child heartbeats on completion from any update route', () => {
    const parent = db.createTask(makeTask({ status: 'ready_for_review' }))!
    const child = db.createTask(makeTask({ status: 'ready_for_review', parent_task_id: parent.id }))!
    dueNow(parent)
    dueNow(child)

    db.updateTask(parent.id, { status: 'completed' })

    expect(db.getTask(parent.id)).toMatchObject({ heartbeat_enabled: false, heartbeat_next_check_at: null })
    expect(db.getTask(child.id)).toMatchObject({ heartbeat_enabled: false, heartbeat_next_check_at: null })
  })

  it('clears old completed task and child flags when the database opens', () => {
    const parent = db.createTask(makeTask({ status: 'completed' }))!
    const child = db.createTask(makeTask({ status: 'ready_for_review', parent_task_id: parent.id }))!
    const rawDb = (db as unknown as { db: import('better-sqlite3').Database }).db
    rawDb.prepare('UPDATE tasks SET heartbeat_enabled = 1, heartbeat_next_check_at = ? WHERE id IN (?, ?)')
      .run(new Date().toISOString(), parent.id, child.id)

    ;(db as unknown as { clearHeartbeatForCompletedTasks: () => void }).clearHeartbeatForCompletedTasks()

    expect(db.getTask(parent.id)).toMatchObject({ heartbeat_enabled: false, heartbeat_next_check_at: null })
    expect(db.getTask(child.id)).toMatchObject({ heartbeat_enabled: false, heartbeat_next_check_at: null })
  })

  it('rejects heartbeat enable for completed tasks and children of completed parents', () => {
    const parent = db.createTask(makeTask({ status: 'completed' }))!
    const child = db.createTask(makeTask({ status: 'ready_for_review', parent_task_id: parent.id }))!

    expect(() => dueNow(parent)).toThrow('Heartbeat cannot be enabled')
    expect(() => dueNow(child)).toThrow('Heartbeat cannot be enabled')
    expect(db.getTask(parent.id)?.heartbeat_enabled).toBe(false)
    expect(db.getTask(child.id)?.heartbeat_enabled).toBe(false)
  })

  it('records a manual disable and clears the next check time', () => {
    const task = db.createTask(makeTask({ status: 'ready_for_review' }))!
    dueNow(task)
    db.updateTask(task.id, { heartbeat_enabled: false })

    expect(db.getTask(task.id)).toMatchObject({ heartbeat_enabled: false, heartbeat_next_check_at: null })
    const disableVersion = db.getSetting(`heartbeat-manual-disable:${task.id}`)
    expect(disableVersion).toBeTruthy()
    db.updateTask(task.id, { heartbeat_enabled: false }, 'heartbeat-auto')
    expect(db.getSetting(`heartbeat-manual-disable:${task.id}`)).toBe(disableVersion)
  })

  it('includes a ready_for_review subtask whose parent task is still active', () => {
    const parent = db.createTask(makeTask({ title: 'Parent', status: 'agent_working' }))!
    const subtask = db.createTask(makeTask({ title: 'Subtask', status: 'ready_for_review', parent_task_id: parent.id }))!
    dueNow(subtask)

    expect(db.getHeartbeatDueTasks().map(t => t.id)).toContain(subtask.id)
  })

  it('includes a due top-level task with no parent', () => {
    const task = db.createTask(makeTask({ title: 'Standalone', status: 'ready_for_review' }))!
    dueNow(task)

    expect(db.getHeartbeatDueTasks().map(t => t.id)).toContain(task.id)
  })
})

describe('Agent CRUD', () => {
  it('creates and retrieves an agent', () => {
    const agent = db.createAgent(makeAgent({ name: 'My Agent' }))
    expect(agent).toBeDefined()
    expect(agent!.name).toBe('My Agent')
    // New agents default to always-allow permissions; see the
    // 'agent permission_mode' describe below for the full matrix.
    expect(agent!.config).toEqual({ permission_mode: 'allow' })
    expect(agent!.is_default).toBe(false)
  })

  it('lists agents', () => {
    db.createAgent(makeAgent({ name: 'Agent 1' }))
    db.createAgent(makeAgent({ name: 'Agent 2' }))
    expect(db.getAgents()).toHaveLength(2)
  })

  it('updates agent fields', () => {
    const agent = db.createAgent(makeAgent())!
    const updated = db.updateAgent(agent.id, {
      name: 'Updated',
      config: { model: 'gpt-4' },
      is_default: true
    })
    expect(updated!.name).toBe('Updated')
    expect(updated!.config.model).toBe('gpt-4')
    expect(updated!.is_default).toBe(true)
  })

  it('deletes an agent', () => {
    const agent = db.createAgent(makeAgent())!
    expect(db.deleteAgent(agent.id)).toBe(true)
    expect(db.getAgent(agent.id)).toBeUndefined()
  })
})

describe('agent permission_mode — always allow by default', () => {
  /**
   * Injects an in-memory DB and builds the real schema, so private seed/
   * migration methods can run against exact rows.
   */
  function makeRawManager(): { manager: DatabaseManager; rawDb: InstanceType<typeof RawDatabase> } {
    const rawDb = new RawDatabase(':memory:')
    rawDb.pragma('journal_mode = WAL')
    rawDb.pragma('foreign_keys = ON')
    const manager = new RealDatabaseManager()
    ;(manager as unknown as { db: unknown }).db = rawDb
    ;(manager as unknown as { createTables(): void }).createTables()
    return { manager, rawDb }
  }

  function insertRawAgent(
    rawDb: InstanceType<typeof RawDatabase>,
    id: string,
    config: string,
    isDefault = 0
  ): void {
    rawDb
      .prepare(
        'INSERT INTO agents (id, name, server_url, config, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, id, 'http://localhost:4096', config, isDefault, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  }

  function rawConfigById(
    rawDb: InstanceType<typeof RawDatabase>
  ): Map<string, { config: string; updated_at: string }> {
    const rows = rawDb.prepare('SELECT id, config, updated_at FROM agents').all() as Array<{
      id: string
      config: string
      updated_at: string
    }>
    return new Map(rows.map((r) => [r.id, { config: r.config, updated_at: r.updated_at }]))
  }

  it('seeds the Default Agent with permission_mode allow on a fresh install', () => {
    // seedDefaultAgent runs on EVERY startup (initialize()), not behind the
    // schema-version gate — a fresh install gets the Default Agent on first
    // launch, always with always-allow permissions.
    const { manager, rawDb } = makeRawManager()
    try {
      ;(manager as unknown as { seedDefaultAgent(): void }).seedDefaultAgent()

      const agents = manager.getAgents()
      expect(agents).toHaveLength(1)
      expect(agents[0].name).toBe('Default Agent')
      expect(agents[0].is_default).toBe(true)
      expect(agents[0].config.permission_mode).toBe('allow')
    } finally {
      rawDb.close()
    }
  })

  it('seed is a no-op once any agent exists (no duplicate Default Agent)', () => {
    const { manager, rawDb } = makeRawManager()
    try {
      manager.createAgent(makeAgent({ name: 'Only Agent' }))

      ;(manager as unknown as { seedDefaultAgent(): void }).seedDefaultAgent()

      expect(manager.getAgents().map((a) => a.name)).toEqual(['Only Agent'])
    } finally {
      rawDb.close()
    }
  })

  it('createAgent fills a missing permission_mode with allow; explicit values win', () => {
    const defaulted = db.createAgent(makeAgent({ name: 'No Mode', config: {} }))
    expect(defaulted!.config.permission_mode).toBe('allow')

    const explicitAsk = db.createAgent(makeAgent({ name: 'Ask', config: { permission_mode: 'ask' } }))
    expect(explicitAsk!.config.permission_mode).toBe('ask')

    const explicitAllow = db.createAgent(makeAgent({ name: 'Allow', config: { permission_mode: 'allow', model: 'm1' } }))
    expect(explicitAllow!.config.permission_mode).toBe('allow')
    expect(explicitAllow!.config.model).toBe('m1')
  })

  it('backfill sets allow only where permission_mode is absent (explicit ask/allow untouched)', () => {
    const { manager, rawDb } = makeRawManager()
    try {
      insertRawAgent(rawDb, 'default-no-key', '{}', 1)
      insertRawAgent(rawDb, 'no-key-with-other-fields', '{"model":"gpt-4","skill_ids":["s1"]}')
      insertRawAgent(rawDb, 'explicit-ask', '{"permission_mode":"ask"}')
      insertRawAgent(rawDb, 'explicit-allow', '{"permission_mode":"allow"}')

      ;(manager as unknown as { migrateAgentPermissionDefaults(): void }).migrateAgentPermissionDefaults()

      const rows = rawConfigById(rawDb)
      expect(JSON.parse(rows.get('default-no-key')!.config)).toEqual({ permission_mode: 'allow' })
      expect(JSON.parse(rows.get('no-key-with-other-fields')!.config)).toEqual({
        model: 'gpt-4',
        skill_ids: ['s1'],
        permission_mode: 'allow'
      })
      // "never changed" cannot be told apart from "user chose ask" — the key
      // being present means the row is left byte-identical.
      expect(rows.get('explicit-ask')!.config).toBe('{"permission_mode":"ask"}')
      expect(rows.get('explicit-allow')!.config).toBe('{"permission_mode":"allow"}')
    } finally {
      rawDb.close()
    }
  })

  it('backfill is JSON-safe: invalid or non-object configs are skipped untouched', () => {
    const { manager, rawDb } = makeRawManager()
    try {
      insertRawAgent(rawDb, 'invalid-json', 'not-json{')
      insertRawAgent(rawDb, 'array-config', '[]')
      insertRawAgent(rawDb, 'string-config', '"hello"')
      insertRawAgent(rawDb, 'null-config', 'null')

      expect(() =>
        (manager as unknown as { migrateAgentPermissionDefaults(): void }).migrateAgentPermissionDefaults()
      ).not.toThrow()

      const rows = rawConfigById(rawDb)
      expect(rows.get('invalid-json')!.config).toBe('not-json{')
      expect(rows.get('array-config')!.config).toBe('[]')
      expect(rows.get('string-config')!.config).toBe('"hello"')
      expect(rows.get('null-config')!.config).toBe('null')
    } finally {
      rawDb.close()
    }
  })

  it('backfill is idempotent — a second pass rewrites nothing', () => {
    const { manager, rawDb } = makeRawManager()
    try {
      insertRawAgent(rawDb, 'default-no-key', '{}', 1)
      insertRawAgent(rawDb, 'explicit-ask', '{"permission_mode":"ask"}')
      insertRawAgent(rawDb, 'invalid-json', 'not-json{')

      const migrate = () => (manager as unknown as { migrateAgentPermissionDefaults(): void }).migrateAgentPermissionDefaults()
      migrate()
      const afterFirst = rawConfigById(rawDb)
      migrate()

      const afterSecond = rawConfigById(rawDb)
      expect([...afterSecond.entries()]).toEqual([...afterFirst.entries()])
      expect(JSON.parse(afterSecond.get('default-no-key')!.config)).toEqual({ permission_mode: 'allow' })
    } finally {
      rawDb.close()
    }
  })
})

describe('MCP Server CRUD', () => {
  it('creates and retrieves a server', () => {
    const server = db.createMcpServer({
      name: 'Test MCP',
      command: 'npx',
      args: ['@test/mcp']
    })
    expect(server).toBeDefined()
    expect(server!.name).toBe('Test MCP')
    expect(server!.type).toBe('local')
    expect(server!.args).toEqual(['@test/mcp'])
  })

  it('creates remote server with url and headers', () => {
    const server = db.createMcpServer({
      name: 'Remote',
      type: 'remote',
      url: 'https://api.example.com',
      headers: { Authorization: 'Bearer tok' }
    })
    expect(server!.type).toBe('remote')
    expect(server!.url).toBe('https://api.example.com')
    expect(server!.headers).toEqual({ Authorization: 'Bearer tok' })
  })

  it('updates server', () => {
    const server = db.createMcpServer({ name: 'Server' })!
    const updated = db.updateMcpServer(server.id, { name: 'Updated Server' })
    expect(updated!.name).toBe('Updated Server')
  })

  it('updateMcpServerTools persists tools', () => {
    const server = db.createMcpServer({ name: 'Server' })!
    const tools = [{ name: 'tool1', description: 'A tool' }]
    db.updateMcpServerTools(server.id, tools)

    const fetched = db.getMcpServer(server.id)
    expect(fetched!.tools).toEqual(tools)
  })

  it('deletes server', () => {
    const server = db.createMcpServer({ name: 'Server' })!
    expect(db.deleteMcpServer(server.id)).toBe(true)
    expect(db.getMcpServer(server.id)).toBeUndefined()
  })

  it("defaults `source` to 'user' when not specified", () => {
    const server = db.createMcpServer({ name: 'User-added MCP' })!
    expect(server.source).toBe('user')
  })

  it("persists `source: 'enterprise'` when set explicitly (used by EnterpriseSyncManager)", () => {
    const server = db.createMcpServer({
      name: '[Workflo] Organisation Workspace',
      type: 'remote',
      url: 'https://api.peakflo.ai/api/mcp/dev/mcp',
      source: 'enterprise'
    })!
    expect(server.source).toBe('enterprise')

    const refetched = db.getMcpServer(server.id)!
    expect(refetched.source).toBe('enterprise')
  })

  it("persists `source: 'plugin'` when set explicitly (used by ClaudePluginManager)", () => {
    const server = db.createMcpServer({
      name: 'my-plugin:some-server',
      source: 'plugin'
    })!
    expect(server.source).toBe('plugin')
  })
})

describe('TaskSource CRUD', () => {
  let mcpServerId: string

  beforeEach(() => {
    const server = db.createMcpServer({ name: 'Server' })!
    mcpServerId = server.id
  })

  it('creates and retrieves a task source', () => {
    const source = db.createTaskSource({
      mcp_server_id: mcpServerId,
      name: 'Source 1',
      plugin_id: 'peakflo',
      list_tool: 'task_list',
      list_tool_args: { status: 'pending' }
    })
    expect(source).toBeDefined()
    expect(source!.name).toBe('Source 1')
    expect(source!.plugin_id).toBe('peakflo')
    expect(source!.list_tool_args).toEqual({ status: 'pending' })
    expect(source!.enabled).toBe(true)
  })

  it('updates a task source', () => {
    const source = db.createTaskSource({
      mcp_server_id: mcpServerId,
      name: 'Source',
      plugin_id: 'peakflo'
    })!
    const updated = db.updateTaskSource(source.id, { name: 'Updated', enabled: false })
    expect(updated!.name).toBe('Updated')
    expect(updated!.enabled).toBe(false)
  })

  it('updateTaskSourceLastSynced sets timestamp', () => {
    const source = db.createTaskSource({
      mcp_server_id: mcpServerId,
      name: 'Source',
      plugin_id: 'peakflo'
    })!
    expect(source.last_synced_at).toBeNull()

    db.updateTaskSourceLastSynced(source.id)
    const updated = db.getTaskSource(source.id)
    expect(updated!.last_synced_at).toBeTruthy()
  })

  it('deletes a task source', () => {
    const source = db.createTaskSource({
      mcp_server_id: mcpServerId,
      name: 'Source',
      plugin_id: 'peakflo'
    })!
    expect(db.deleteTaskSource(source.id)).toBe(true)
    expect(db.getTaskSource(source.id)).toBeUndefined()
  })

  it('CASCADE deletes tasks when source is deleted', () => {
    // Create task source
    const source = db.createTaskSource({
      mcp_server_id: mcpServerId,
      name: 'Test Source',
      plugin_id: 'peakflo'
    })!

    // Create tasks linked to this source
    const task1 = db.createTask(makeTask({
      title: 'Task 1',
      external_id: 'ext-1',
      source_id: source.id,
      source: 'Test Source'
    }))!

    const task2 = db.createTask(makeTask({
      title: 'Task 2',
      external_id: 'ext-2',
      source_id: source.id,
      source: 'Test Source'
    }))!

    // Create a task without source_id (should not be deleted)
    const task3 = db.createTask(makeTask({
      title: 'Task 3 (no source)'
    }))!

    // Verify tasks exist
    expect(db.getTask(task1.id)).toBeDefined()
    expect(db.getTask(task2.id)).toBeDefined()
    expect(db.getTask(task3.id)).toBeDefined()
    expect(db.getTasks()).toHaveLength(3)

    // Delete the task source
    expect(db.deleteTaskSource(source.id)).toBe(true)

    // Verify that tasks with source_id are CASCADE deleted
    expect(db.getTask(task1.id)).toBeUndefined()
    expect(db.getTask(task2.id)).toBeUndefined()

    // Verify that task without source_id still exists
    expect(db.getTask(task3.id)).toBeDefined()
    expect(db.getTasks()).toHaveLength(1)
  })
})

describe('Skill CRUD', () => {
  it('creates and retrieves a skill', () => {
    const skill = db.createSkill(makeSkill({ name: 'Deploy' }))
    expect(skill).toBeDefined()
    expect(skill!.name).toBe('Deploy')
    expect(skill!.version).toBe(1)
  })

  it('lists skills sorted by name', () => {
    db.createSkill(makeSkill({ name: 'Zeta' }))
    db.createSkill(makeSkill({ name: 'Alpha' }))
    const skills = db.getSkills()
    expect(skills[0].name).toBe('Alpha')
    expect(skills[1].name).toBe('Zeta')
  })

  it('getByName finds the right skill', () => {
    db.createSkill(makeSkill({ name: 'UniqueSkill' }))
    const found = db.getSkillByName('UniqueSkill')
    expect(found).toBeDefined()
    expect(found!.name).toBe('UniqueSkill')
  })

  it('getByIds returns matching skills', () => {
    const s1 = db.createSkill(makeSkill({ name: 'A' }))!
    const s2 = db.createSkill(makeSkill({ name: 'B' }))!
    db.createSkill(makeSkill({ name: 'C' }))

    const result = db.getSkillsByIds([s1.id, s2.id])
    expect(result).toHaveLength(2)
  })

  it('getByIds returns empty for empty array', () => {
    expect(db.getSkillsByIds([])).toEqual([])
  })

  it('updates a skill and increments version', () => {
    const skill = db.createSkill(makeSkill())!
    expect(skill.version).toBe(1)

    const updated = db.updateSkill(skill.id, { name: 'Updated' })
    expect(updated!.name).toBe('Updated')
    expect(updated!.version).toBe(2)
  })

  it('soft-deletes a skill', () => {
    const skill = db.createSkill(makeSkill())!
    const result = db.deleteSkill(skill.id)
    expect(result).toBe(true)

    // getSkill should not find soft-deleted
    expect(db.getSkill(skill.id)).toBeUndefined()
    // getSkills should not include it
    expect(db.getSkills()).toHaveLength(0)
  })

  it('double soft-delete returns false', () => {
    const skill = db.createSkill(makeSkill())!
    db.deleteSkill(skill.id)
    expect(db.deleteSkill(skill.id)).toBe(false)
  })
})

describe('Settings CRUD', () => {
  it('sets and gets a setting', () => {
    db.setSetting('theme', 'dark')
    expect(db.getSetting('theme')).toBe('dark')
  })

  it('returns undefined for missing setting', () => {
    expect(db.getSetting('missing')).toBeUndefined()
  })

  it('upserts an existing setting', () => {
    db.setSetting('key', 'val1')
    db.setSetting('key', 'val2')
    expect(db.getSetting('key')).toBe('val2')
  })

  it('getAllSettings returns all entries', () => {
    db.setSetting('a', '1')
    db.setSetting('b', '2')
    const all = db.getAllSettings()
    expect(all).toEqual({ a: '1', b: '2' })
  })

  it('deleteSetting removes entry', () => {
    db.setSetting('key', 'val')
    db.deleteSetting('key')
    expect(db.getSetting('key')).toBeUndefined()
  })
})

describe('Closed database behavior', () => {
  it('returns safe defaults after close', () => {
    db.close()

    expect(db.getTasks()).toEqual([])
    expect(db.getTask('any-id')).toBeUndefined()
    expect(db.getMcpServer('any-id')).toBeUndefined()
  })
})

describe('Durable transcript projection', () => {
  it('waits for a concurrent writer before calculating transcript sequence and revision', async () => {
    const dir = mkdtempSync(join(tmpdir(), '20x-transcript-lock-'))
    const dbPath = join(dir, 'transcript.db')
    const rawDb = new RawDatabase(dbPath)
    rawDb.pragma('journal_mode = WAL')
    rawDb.pragma('busy_timeout = 1000')
    rawDb.exec(`
      CREATE TABLE transcript_parts (
        task_id TEXT NOT NULL,
        part_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL DEFAULT 'system',
        content TEXT NOT NULL DEFAULT '',
        part_type TEXT,
        tool TEXT,
        payload TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        rev INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (task_id, part_id)
      )
    `)
    const manager = new RealDatabaseManager()
    manager.db = rawDb

    const lockHolder = spawn(process.execPath, ['-e', `
      const Database = require('better-sqlite3')
      const db = new Database(process.argv[1])
      db.pragma('journal_mode = WAL')
      db.exec('BEGIN IMMEDIATE')
      db.prepare('INSERT INTO transcript_parts (task_id, part_id, seq, role, content, created_at, updated_at, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('task-1', 'other-process', 1, 'assistant', 'concurrent write', 1, 1, 1)
      process.stdout.write('locked\\n')
      setTimeout(() => {
        db.exec('COMMIT')
        db.close()
      }, 200)
    `, dbPath], {
      cwd: process.cwd(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    try {
      await once(lockHolder.stdout!, 'data')

      expect(() => manager.upsertTranscriptParts('task-1', [
        { id: 'p1', role: 'assistant', content: 'persisted after contention' }
      ])).not.toThrow()

      if (lockHolder.exitCode === null) await once(lockHolder, 'exit')
      expect(manager.getTranscriptParts('task-1').map((part) => [part.partId, part.seq, part.rev]))
        .toEqual([
          ['other-process', 1, 1],
          ['p1', 2, 2]
        ])
    } finally {
      if (lockHolder.exitCode === null) lockHolder.kill()
      rawDb.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('assigns monotonic per-task seq to new parts', () => {
    db.upsertTranscriptParts('task-1', [
      { id: 'p1', role: 'user', content: 'hello' },
      { id: 'p2', role: 'assistant', content: 'hi there' }
    ])
    db.upsertTranscriptParts('task-1', [{ id: 'p3', role: 'assistant', content: 'more' }])
    db.upsertTranscriptParts('task-2', [{ id: 'p1', role: 'user', content: 'other task' }])

    const parts = db.getTranscriptParts('task-1')
    expect(parts.map((p) => [p.partId, p.seq])).toEqual([['p1', 1], ['p2', 2], ['p3', 3]])
    // Separate task gets its own seq space and can reuse part ids
    expect(db.getTranscriptParts('task-2')).toHaveLength(1)
    expect(db.getTranscriptParts('task-2')[0].seq).toBe(1)
  })

  it('streaming update replaces content but keeps position (seq)', () => {
    db.upsertTranscriptParts('task-1', [
      { id: 'p1', role: 'assistant', content: 'partial' },
      { id: 'p2', role: 'assistant', content: 'after' }
    ])
    db.upsertTranscriptParts('task-1', [{ id: 'p1', role: 'assistant', content: 'partial then complete' }])

    const parts = db.getTranscriptParts('task-1')
    expect(parts).toHaveLength(2)
    expect(parts[0].partId).toBe('p1')
    expect(parts[0].seq).toBe(1)
    expect(parts[0].content).toBe('partial then complete')
  })

  it('preserves tool/payload JSON and supports sinceSeq snapshots', () => {
    db.upsertTranscriptParts('task-1', [
      { id: 'p1', role: 'assistant', content: '', partType: 'tool', tool: { name: 'bash', status: 'success' } },
      { id: 'p2', role: 'assistant', content: 'done', payload: { todos: [{ content: 'x', status: 'completed' }] } }
    ])

    const all = db.getTranscriptParts('task-1')
    expect((all[0].tool as { name: string }).name).toBe('bash')
    expect((all[1].payload as { todos: unknown[] }).todos).toHaveLength(1)

    const delta = db.getTranscriptParts('task-1', 1)
    expect(delta).toHaveLength(1)
    expect(delta[0].partId).toBe('p2')
    expect(db.getTranscriptMaxSeq('task-1')).toBe(2)
  })

  it('hasTranscriptParts and deletion cleanup', () => {
    expect(db.hasTranscriptParts('task-1')).toBe(false)
    db.upsertTranscriptParts('task-1', [{ id: 'p1', content: 'x' }])
    expect(db.hasTranscriptParts('task-1')).toBe(true)

    db.deleteTranscriptParts('task-1')
    expect(db.hasTranscriptParts('task-1')).toBe(false)
    expect(db.getTranscriptParts('task-1')).toHaveLength(0)
  })
})

describe('Durable transcript — timestamp provenance', () => {
  it('persists the original receivedAt as created_at (bulk seed keeps chronology)', () => {
    // A bulk seed/replay writes the whole history in one burst. Each part must
    // keep its ORIGINAL time, not a single shared write-time.
    const t0 = 1_700_000_000_000
    db.upsertTranscriptParts('task-1', [
      { id: 'p1', role: 'user', content: 'first', receivedAt: t0 },
      { id: 'p2', role: 'assistant', content: 'second', receivedAt: t0 + 30_000 },
      { id: 'p3', role: 'assistant', content: 'third', receivedAt: t0 + 90_000 }
    ])

    const parts = db.getTranscriptParts('task-1')
    expect(parts.map((p) => p.createdAt)).toEqual([t0, t0 + 30_000, t0 + 90_000])
    // Not collapsed to one shared timestamp
    expect(new Set(parts.map((p) => p.createdAt)).size).toBe(3)
  })

  it('falls back to write-time only when receivedAt is absent', () => {
    const before = Date.now()
    db.upsertTranscriptParts('task-2', [{ id: 'p1', content: 'x' }])
    const [p] = db.getTranscriptParts('task-2')
    expect(p.createdAt).toBeGreaterThanOrEqual(before)
  })

  it('preserves created_at across a later reconcile upsert', () => {
    const t0 = 1_700_000_000_000
    db.upsertTranscriptParts('task-3', [{ id: 'p1', content: 'partial', receivedAt: t0 }])
    // Reconcile pass re-writes the same part with new content (no receivedAt)
    db.upsertTranscriptParts('task-3', [{ id: 'p1', content: 'partial then final' }])
    const [p] = db.getTranscriptParts('task-3')
    expect(p.content).toBe('partial then final')
    expect(p.createdAt).toBe(t0) // original time preserved
  })
})

describe('Durable transcript — rev cursor + delta (event-sourced)', () => {
  it('answers the global max rev and the snapshot order from indexes, not table scans', () => {
    // Every streamed write batch reads MAX(rev) across all tasks; without an
    // index that is a scan of the whole transcript table.
    const rawDb = (db as unknown as { db: import('better-sqlite3').Database }).db
    const plan = (sql: string): string => (rawDb.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
      .map((row) => row.detail).join(' | ')
    expect(plan('SELECT COALESCE(MAX(rev), 0) AS m FROM transcript_parts')).toContain('idx_transcript_parts_rev')
    expect(plan("SELECT * FROM transcript_parts WHERE task_id = 't1' ORDER BY created_at ASC, seq ASC"))
      .not.toContain('TEMP B-TREE')
  })

  it('assigns a global monotonic rev on insert and bumps it on content update', () => {
    const r1 = db.upsertTranscriptParts('t1', [{ id: 'a', role: 'user', content: 'hi' }])
    const r2 = db.upsertTranscriptParts('t1', [{ id: 'b', role: 'assistant', content: 'yo' }])
    expect(r2.maxRev).toBeGreaterThan(r1.maxRev)
    // content update to 'a' bumps its rev above b
    const r3 = db.upsertTranscriptParts('t1', [{ id: 'a', role: 'user', content: 'hi there' }])
    expect(r3.maxRev).toBeGreaterThan(r2.maxRev)
    const parts = db.getTranscriptParts('t1')
    expect(parts.find((p) => p.partId === 'a')!.rev).toBe(r3.maxRev)
  })

  it('getTranscriptDelta returns only parts changed after sinceRev (incl. updates)', () => {
    db.upsertTranscriptParts('t1', [{ id: 'a', role: 'user', content: 'one' }])
    const afterA = db.getTranscriptMaxRev('t1')
    db.upsertTranscriptParts('t1', [{ id: 'b', role: 'assistant', content: 'two' }])
    db.upsertTranscriptParts('t1', [{ id: 'a', role: 'user', content: 'one-edited' }]) // update

    const delta = db.getTranscriptDelta('t1', afterA)
    const ids = delta.parts.map((p) => p.partId).sort()
    expect(ids).toEqual(['a', 'b']) // b inserted, a updated — both after afterA
    expect(delta.parts.find((p) => p.partId === 'a')!.content).toBe('one-edited')
    expect(delta.maxRev).toBe(db.getTranscriptMaxRev('t1'))
  })

  it('delta since current maxRev is empty (idempotent cursor)', () => {
    db.upsertTranscriptParts('t1', [{ id: 'a', content: 'x' }])
    const max = db.getTranscriptMaxRev('t1')
    expect(db.getTranscriptDelta('t1', max).parts).toHaveLength(0)
  })

  it('rev is per-global but delta is task-scoped', () => {
    db.upsertTranscriptParts('t1', [{ id: 'a', content: 'x' }])
    db.upsertTranscriptParts('t2', [{ id: 'a', content: 'other task' }])
    // t1 delta since 0 should only include t1's part
    const d = db.getTranscriptDelta('t1', 0)
    expect(d.parts.every((p) => p.taskId === 't1')).toBe(true)
  })
})

describe('transcript_parts.rev migration on a legacy DB (no rev column)', () => {
  // Regression: a DB created before `rev` existed crashed on startup with
  // "no such column: rev" because createTables built the (task_id, rev) index
  // before the ALTER TABLE migration added the column. createTables must not
  // reference rev; ensureTranscriptRevColumn owns the column + index.
  function makeLegacyManager(): { manager: DatabaseManager; rawDb: InstanceType<typeof RawDatabase> } {
    const rawDb = new RawDatabase(':memory:')
    rawDb.pragma('journal_mode = WAL')
    rawDb.pragma('foreign_keys = ON')
    // Legacy schema: transcript_parts WITHOUT the rev column (and no rev index).
    rawDb.exec(`
      CREATE TABLE transcript_parts (
        task_id TEXT NOT NULL,
        part_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL DEFAULT 'system',
        content TEXT NOT NULL DEFAULT '',
        part_type TEXT,
        tool TEXT,
        payload TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
        PRIMARY KEY (task_id, part_id)
      );
      CREATE INDEX idx_transcript_parts_task_seq ON transcript_parts(task_id, seq);
      INSERT INTO transcript_parts (task_id, part_id, seq, role, content, created_at, updated_at)
        VALUES ('t1', 'p1', 1, 'assistant', 'first',  100, 100),
               ('t1', 'p2', 2, 'assistant', 'second', 200, 200),
               ('t1', 'p3', 3, 'assistant', 'third',  300, 300);
    `)
    const manager = new RealDatabaseManager()
    ;(manager as unknown as { db: unknown }).db = rawDb
    return { manager, rawDb }
  }

  it('createTables does not throw on a legacy DB, and the migration adds+backfills rev', () => {
    const { manager, rawDb } = makeLegacyManager()

    // Previously threw "no such column: rev" inside createTables.
    expect(() => (manager as unknown as { createTables(): void }).createTables()).not.toThrow()
    expect(() =>
      (manager as unknown as { ensureTranscriptRevColumn(): void }).ensureTranscriptRevColumn()
    ).not.toThrow()

    // Column now exists.
    const cols = rawDb.prepare('PRAGMA table_info(transcript_parts)').all() as Array<{ name: string }>
    expect(cols.some((c) => c.name === 'rev')).toBe(true)

    // Existing rows backfilled with a monotonic rev ordered by (created_at, seq).
    const rows = rawDb
      .prepare('SELECT part_id, rev FROM transcript_parts WHERE task_id = ? ORDER BY rev ASC')
      .all('t1') as Array<{ part_id: string; rev: number }>
    expect(rows.map((r) => r.part_id)).toEqual(['p1', 'p2', 'p3'])
    expect(rows[0].rev).toBeLessThan(rows[1].rev)
    expect(rows[1].rev).toBeLessThan(rows[2].rev)

    // The rev index is present after migration.
    const idx = rawDb
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_transcript_parts_task_rev'")
      .get()
    expect(idx).toBeDefined()

    // Delta queries work against the migrated DB.
    expect(manager.getTranscriptDelta('t1', 0).parts).toHaveLength(3)
  })

  it('is idempotent when the column already exists', () => {
    const { manager, rawDb } = makeLegacyManager()
    ;(manager as unknown as { ensureTranscriptRevColumn(): void }).ensureTranscriptRevColumn()
    const before = (rawDb.prepare('SELECT COALESCE(MAX(rev),0) AS m FROM transcript_parts').get() as { m: number }).m
    // Second run must not throw or re-backfill.
    expect(() =>
      (manager as unknown as { ensureTranscriptRevColumn(): void }).ensureTranscriptRevColumn()
    ).not.toThrow()
    const after = (rawDb.prepare('SELECT COALESCE(MAX(rev),0) AS m FROM transcript_parts').get() as { m: number }).m
    expect(after).toBe(before)
  })
})

describe('Context handoff marker on agent reassignment', () => {
  const key = (taskId: string) => `context-handoff:${taskId}`
  // createTask does not store agent_id; assignment is an update, as in the app.
  const assigned = (agentId: string) => {
    const task = db.createTask(makeTask())!
    db.updateTask(task.id, { agent_id: agentId })
    return task
  }

  it('records the agent a task left once it has a transcript', () => {
    const first = db.createAgent(makeAgent({ name: 'First' }))!
    const second = db.createAgent(makeAgent({ name: 'Second' }))!
    const task = assigned(first.id)
    db.upsertTranscriptParts(task.id, [{ id: 'p1', role: 'user', content: 'hello' }])

    db.updateTask(task.id, { agent_id: second.id })

    expect(JSON.parse(db.getSetting(key(task.id))!)).toMatchObject({ fromAgentId: first.id })
  })

  it('records nothing for a task without a transcript', () => {
    const first = db.createAgent(makeAgent({ name: 'First' }))!
    const second = db.createAgent(makeAgent({ name: 'Second' }))!
    const task = assigned(first.id)

    db.updateTask(task.id, { agent_id: second.id })

    expect(db.getSetting(key(task.id))).toBeUndefined()
  })

  it('keeps the original agent when the task passes through unassigned', () => {
    const first = db.createAgent(makeAgent({ name: 'First' }))!
    const second = db.createAgent(makeAgent({ name: 'Second' }))!
    const task = assigned(first.id)
    db.upsertTranscriptParts(task.id, [{ id: 'p1', role: 'user', content: 'hello' }])

    db.updateTask(task.id, { agent_id: null })
    db.updateTask(task.id, { agent_id: second.id })

    expect(JSON.parse(db.getSetting(key(task.id))!)).toMatchObject({ fromAgentId: first.id })
  })

  it('keeps the first agent through several reassignments before the handoff is delivered', () => {
    const first = db.createAgent(makeAgent({ name: 'First' }))!
    const second = db.createAgent(makeAgent({ name: 'Second' }))!
    const third = db.createAgent(makeAgent({ name: 'Third' }))!
    const task = assigned(first.id)
    db.upsertTranscriptParts(task.id, [{ id: 'p1', role: 'user', content: 'hello' }])

    db.updateTask(task.id, { agent_id: second.id })
    db.updateTask(task.id, { agent_id: third.id })

    expect(JSON.parse(db.getSetting(key(task.id))!)).toMatchObject({ fromAgentId: first.id, announced: false })
  })

  it('keeps the session id when the task is reassigned to another harness, until the new session replaces it', () => {
    const first = db.createAgent(makeAgent({ name: 'First', config: { coding_agent: 'claude-code' } }))!
    const second = db.createAgent(makeAgent({ name: 'Second', config: { coding_agent: 'codex' } }))!
    const task = assigned(first.id)
    db.upsertTranscriptParts(task.id, [{ id: 'p1', role: 'user', content: 'hello' }])
    db.updateTask(task.id, { session_id: 'backend-session-1' })

    const updated = db.updateTask(task.id, { agent_id: second.id })

    // Never dropped before the context has been carried: the handoff is planned at resume time.
    expect(updated?.session_id).toBe('backend-session-1')
    expect(JSON.parse(db.getSetting(key(task.id))!)).toMatchObject({ fromAgentId: first.id, announced: false })
  })

  it('records a marker for a reassignment of a task that has a session but no transcript yet', () => {
    const first = db.createAgent(makeAgent({ name: 'First', config: { coding_agent: 'codex' } }))!
    const second = db.createAgent(makeAgent({ name: 'Second', config: { coding_agent: 'codex' } }))!
    const task = assigned(first.id)
    db.updateTask(task.id, { session_id: 'thread-1' })

    db.updateTask(task.id, { agent_id: second.id })

    expect(JSON.parse(db.getSetting(key(task.id))!)).toMatchObject({ fromAgentId: first.id })
  })

  it('keeps the session when the task moves to another agent of the same harness', () => {
    const first = db.createAgent(makeAgent({ name: 'First', config: { coding_agent: 'claude-code' } }))!
    const second = db.createAgent(makeAgent({ name: 'Second', config: { coding_agent: 'claude-code', model: 'other' } }))!
    const task = assigned(first.id)
    db.upsertTranscriptParts(task.id, [{ id: 'p1', role: 'user', content: 'hello' }])
    db.updateTask(task.id, { session_id: 'backend-session-1' })

    const updated = db.updateTask(task.id, { agent_id: second.id })

    expect(updated?.session_id).toBe('backend-session-1')
    expect(updated?.agent_id).toBe(second.id)
    // The marker is still written, so a failed native resume can fall back to the handoff.
    expect(JSON.parse(db.getSetting(key(task.id))!)).toMatchObject({ fromAgentId: first.id, announced: false })
  })

  it('keeps the session id when the task is unassigned', () => {
    const first = db.createAgent(makeAgent({ name: 'First', config: { coding_agent: 'claude-code' } }))!
    const task = assigned(first.id)
    db.updateTask(task.id, { session_id: 'backend-session-1' })

    const updated = db.updateTask(task.id, { agent_id: null })

    expect(updated?.session_id).toBe('backend-session-1')
  })

  it('keeps the session when the agent does not change', () => {
    const first = db.createAgent(makeAgent({ name: 'First' }))!
    const task = assigned(first.id)
    db.updateTask(task.id, { session_id: 'backend-session-1' })

    const updated = db.updateTask(task.id, { title: 'Renamed', agent_id: first.id })

    expect(updated?.session_id).toBe('backend-session-1')
  })

  it('does not record a change when the same agent is assigned again', () => {
    const first = db.createAgent(makeAgent({ name: 'First' }))!
    const task = assigned(first.id)
    db.upsertTranscriptParts(task.id, [{ id: 'p1', role: 'user', content: 'hello' }])

    db.updateTask(task.id, { agent_id: first.id })

    expect(db.getSetting(key(task.id))).toBeUndefined()
  })
})
