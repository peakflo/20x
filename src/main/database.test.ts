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

describe('Agent CRUD', () => {
  it('creates and retrieves an agent', () => {
    const agent = db.createAgent(makeAgent({ name: 'My Agent' }))
    expect(agent).toBeDefined()
    expect(agent!.name).toBe('My Agent')
    expect(agent!.config).toEqual({})
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
