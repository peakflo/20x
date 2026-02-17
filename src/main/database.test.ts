import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeTask, makeAgent, makeSkill } from '../../test/helpers/task-fixtures'
import type { DatabaseManager } from './database'

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

  it('does not update non-updatable fields', () => {
    const task = db.createTask(makeTask())!
    const updated = db.updateTask(task.id, { title: 'New' } as any)
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
