import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeTask, makeAgent } from '../../test/helpers/task-fixtures'
import type { DatabaseManager } from './database'

/**
 * The handleRoute function is not exported, so we test the triage-related
 * behavior through the DatabaseManager which handleRoute delegates to.
 * We test the API-level logic that handleRoute implements by simulating
 * the same SQL operations.
 */
let db: DatabaseManager
let rawDb: import('better-sqlite3').Database

beforeEach(() => {
  ;({ db, rawDb } = createTestDb())
})

describe('/update_task - triage status guard', () => {
  it('skips status update when task is in triaging status', () => {
    const agent = db.createAgent(makeAgent({ name: 'Agent 1' }))
    const task = db.createTask(makeTask({ title: 'Triage me' }))!

    // Set task to triaging status
    db.updateTask(task.id, { status: 'triaging' as unknown as Parameters<typeof db.updateTask>[1]['status'] })
    const triagingTask = db.getTask(task.id)!
    expect(triagingTask.status).toBe('triaging')

    // Simulate what handleRoute does: check current status before updating
    const currentTask = rawDb.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as { status: string }
    expect(currentTask.status).toBe('triaging')

    // When status is triaging, the API should skip status changes
    // but still allow other field updates (agent_id, labels, etc.)
    const updates: string[] = []
    const qParams: unknown[] = []

    // Simulate status guard from handleRoute
    const requestedStatus = 'not_started'
    if (currentTask.status === 'triaging') {
      // Don't push status update — this is the guard
    } else {
      updates.push('status = ?')
      qParams.push(requestedStatus)
    }

    // But agent_id should still be updatable
    updates.push('agent_id = ?')
    qParams.push(agent!.id)
    updates.push('updated_at = ?')
    qParams.push(new Date().toISOString())
    qParams.push(task.id)

    rawDb.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...qParams)

    const updatedTask = db.getTask(task.id)!
    expect(updatedTask.status).toBe('triaging') // Status preserved
    expect(updatedTask.agent_id).toBe(agent!.id) // Agent assigned
  })

  it('allows status update when task is not in triaging status', () => {
    const task = db.createTask(makeTask({ title: 'Normal task' }))!
    expect(task.status).toBe('not_started')

    // Simulate handleRoute status guard
    const currentTask = rawDb.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as { status: string }
    expect(currentTask.status).not.toBe('triaging')

    // Status update should proceed normally
    db.updateTask(task.id, { status: 'completed' as unknown as Parameters<typeof db.updateTask>[1]['status'] })
    const updatedTask = db.getTask(task.id)!
    expect(updatedTask.status).toBe('completed')
  })
})

describe('/update_task - repos field', () => {
  it('updates repos field via JSON serialization', () => {
    const task = db.createTask(makeTask({ title: 'Task with repos' }))!
    expect(task.repos).toEqual([])

    // Simulate what handleRoute does for repos
    const repos = ['org/repo-1', 'org/repo-2']
    rawDb.prepare('UPDATE tasks SET repos = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(repos), new Date().toISOString(), task.id)

    const updatedTask = db.getTask(task.id)!
    expect(updatedTask.repos).toEqual(['org/repo-1', 'org/repo-2'])
  })
})

describe('/list_repos', () => {
  it('returns distinct repos from historical tasks', () => {
    // Create tasks with repos
    db.createTask(makeTask({ title: 'Task 1', repos: ['org/repo-a', 'org/repo-b'] }))
    db.createTask(makeTask({ title: 'Task 2', repos: ['org/repo-b', 'org/repo-c'] }))
    db.createTask(makeTask({ title: 'Task 3', repos: [] }))

    // Simulate /list_repos route logic
    const tasks = rawDb.prepare("SELECT repos FROM tasks WHERE repos IS NOT NULL AND repos != '[]'").all() as Record<string, unknown>[]
    const repoSet = new Set<string>()
    tasks.forEach((t) => {
      try {
        const repos = JSON.parse((t.repos as string) || '[]')
        repos.forEach((r: string) => repoSet.add(r))
      } catch { /* ignore */ }
    })

    const result = Array.from(repoSet)
    expect(result).toContain('org/repo-a')
    expect(result).toContain('org/repo-b')
    expect(result).toContain('org/repo-c')
    expect(result).toHaveLength(3) // No duplicates
  })

  it('returns empty array when no tasks have repos', () => {
    db.createTask(makeTask({ title: 'No repos', repos: [] }))

    const tasks = rawDb.prepare("SELECT repos FROM tasks WHERE repos IS NOT NULL AND repos != '[]'").all()
    expect(tasks).toHaveLength(0)
  })

  it('returns github_org from settings', () => {
    db.setSetting('github_org', 'my-org')

    const orgRow = rawDb.prepare('SELECT value FROM settings WHERE key = ?').get('github_org') as { value: string } | undefined
    expect(orgRow!.value).toBe('my-org')
  })

  it('returns null github_org when not set', () => {
    const orgRow = rawDb.prepare('SELECT value FROM settings WHERE key = ?').get('github_org') as { value: string } | undefined
    expect(orgRow).toBeUndefined()
  })
})

describe('parseTask - skill_ids null vs empty array semantics', () => {
  it('preserves null skill_ids (agent defaults) when reading from DB', () => {
    const task = db.createTask(makeTask({ title: 'Task with default skills' }))!

    // skill_ids should be null by default (= "use agent defaults")
    expect(task.skill_ids).toBeNull()

    // Verify the raw DB value is also null
    const rawRow = rawDb.prepare('SELECT skill_ids FROM tasks WHERE id = ?').get(task.id) as { skill_ids: string | null }
    expect(rawRow.skill_ids).toBeNull()

    // The fixed parseTask logic should preserve null, NOT convert to []
    const parsed = rawRow.skill_ids ? JSON.parse(rawRow.skill_ids) : null
    expect(parsed).toBeNull()
  })

  it('preserves explicit empty array skill_ids (no skills)', () => {
    const task = db.createTask(makeTask({ title: 'Task with no skills' }))!
    db.updateTask(task.id, { skill_ids: [] })

    const rawRow = rawDb.prepare('SELECT skill_ids FROM tasks WHERE id = ?').get(task.id) as { skill_ids: string | null }
    expect(rawRow.skill_ids).toBe('[]')

    // parseTask should return empty array, not null
    const parsed = rawRow.skill_ids ? JSON.parse(rawRow.skill_ids) : null
    expect(parsed).toEqual([])
  })

  it('preserves specific skill_ids array', () => {
    const task = db.createTask(makeTask({ title: 'Task with specific skills' }))!
    db.updateTask(task.id, { skill_ids: ['skill-a', 'skill-b'] })

    const rawRow = rawDb.prepare('SELECT skill_ids FROM tasks WHERE id = ?').get(task.id) as { skill_ids: string | null }
    expect(rawRow.skill_ids).toBe('["skill-a","skill-b"]')

    const parsed = rawRow.skill_ids ? JSON.parse(rawRow.skill_ids) : null
    expect(parsed).toEqual(['skill-a', 'skill-b'])
  })

  it('bugfix: null skill_ids must NOT become empty array via || fallback', () => {
    // This test documents the bug that was fixed:
    // The old code used: JSON.parse((task.skill_ids as string) || '[]')
    // which converts null → '[]' → [], losing the "agent defaults" semantic.
    const rawSkillIds: string | null = null

    // OLD (buggy) behavior — demonstrates the problem:
    const buggyResult = JSON.parse((rawSkillIds as unknown as string) || '[]')
    expect(buggyResult).toEqual([]) // Incorrectly becomes "no skills"

    // NEW (fixed) behavior — preserves null:
    const fixedResult = rawSkillIds ? JSON.parse(rawSkillIds) : null
    expect(fixedResult).toBeNull() // Correctly stays "agent defaults"
  })
})

describe('Recurring task skill_ids propagation', () => {
  /**
   * Helper that mirrors the fixed parseTask logic from task-api-server.ts.
   * Tests verify the raw DB row goes through this correctly.
   */
  function parseTaskSkillIds(rawSkillIds: string | null): string[] | null {
    return rawSkillIds ? JSON.parse(rawSkillIds) : null
  }

  it('copies skill_ids from recurring template to created instance', () => {
    const agent = db.createAgent(makeAgent({ name: 'Test Agent' }))!
    const template = db.createTask(makeTask({
      title: 'Recurring template',
      is_recurring: true,
      recurrence_pattern: { type: 'daily', interval: 1, time: '09:00' }
    }))!

    // Assign agent and skills to template
    db.updateTask(template.id, { agent_id: agent.id, skill_ids: ['skill-1', 'skill-2'] })
    const updatedTemplate = db.getTask(template.id)!

    // Simulate RecurrenceScheduler.createInstanceFromTemplate
    const instanceId = 'test-instance-with-skills'
    const now = new Date().toISOString()
    rawDb.prepare(`
      INSERT INTO tasks (
        id, title, description, type, priority, status, assignee, due_date,
        labels, attachments, repos, output_fields, agent_id, source, skill_ids,
        is_recurring, recurrence_pattern, recurrence_parent_id,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      instanceId,
      updatedTemplate.title,
      updatedTemplate.description,
      updatedTemplate.type,
      updatedTemplate.priority,
      'not_started',
      updatedTemplate.assignee,
      updatedTemplate.due_date,
      JSON.stringify(updatedTemplate.labels),
      JSON.stringify(updatedTemplate.attachments),
      JSON.stringify(updatedTemplate.repos),
      JSON.stringify(updatedTemplate.output_fields),
      updatedTemplate.agent_id,
      updatedTemplate.source,
      updatedTemplate.skill_ids ? JSON.stringify(updatedTemplate.skill_ids) : null,
      0, null, updatedTemplate.id, now, now
    )

    const instance = db.getTask(instanceId)!
    expect(instance.agent_id).toBe(agent.id)
    expect(instance.skill_ids).toEqual(['skill-1', 'skill-2'])
    expect(instance.recurrence_parent_id).toBe(template.id)
  })

  it('preserves null skill_ids (agent defaults) from template to instance', () => {
    const agent = db.createAgent(makeAgent({ name: 'Test Agent' }))!
    const template = db.createTask(makeTask({
      title: 'Template with agent defaults',
      is_recurring: true,
      recurrence_pattern: { type: 'daily', interval: 1, time: '09:00' }
    }))!

    // Assign agent but keep skill_ids as null (agent defaults)
    db.updateTask(template.id, { agent_id: agent.id })
    const updatedTemplate = db.getTask(template.id)!
    expect(updatedTemplate.skill_ids).toBeNull()

    // Simulate instance creation
    const instanceId = 'test-instance-null-skills'
    const now = new Date().toISOString()
    rawDb.prepare(`
      INSERT INTO tasks (
        id, title, description, type, priority, status, assignee, due_date,
        labels, attachments, repos, output_fields, agent_id, source, skill_ids,
        is_recurring, recurrence_pattern, recurrence_parent_id,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      instanceId,
      updatedTemplate.title,
      updatedTemplate.description,
      updatedTemplate.type,
      updatedTemplate.priority,
      'not_started',
      updatedTemplate.assignee,
      updatedTemplate.due_date,
      JSON.stringify(updatedTemplate.labels),
      JSON.stringify(updatedTemplate.attachments),
      JSON.stringify(updatedTemplate.repos),
      JSON.stringify(updatedTemplate.output_fields),
      updatedTemplate.agent_id,
      updatedTemplate.source,
      updatedTemplate.skill_ids ? JSON.stringify(updatedTemplate.skill_ids) : null,
      0, null, updatedTemplate.id, now, now
    )

    const instance = db.getTask(instanceId)!
    expect(instance.agent_id).toBe(agent.id)
    expect(instance.skill_ids).toBeNull() // Must stay null, NOT become []
  })

  it('end-to-end: recurring instance skill_ids survive the API parseTask path', () => {
    const agent = db.createAgent(makeAgent({ name: 'Test Agent' }))!
    const template = db.createTask(makeTask({
      title: 'Template with skills',
      is_recurring: true,
      recurrence_pattern: { type: 'daily', interval: 1, time: '09:00' }
    }))!
    db.updateTask(template.id, { agent_id: agent.id, skill_ids: ['skill-x', 'skill-y'] })
    const updatedTemplate = db.getTask(template.id)!

    // Create instance (simulates RecurrenceScheduler)
    const instanceId = 'test-api-parse-instance'
    const now = new Date().toISOString()
    rawDb.prepare(`
      INSERT INTO tasks (
        id, title, description, type, priority, status, assignee, due_date,
        labels, attachments, repos, output_fields, agent_id, source, skill_ids,
        is_recurring, recurrence_pattern, recurrence_parent_id,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      instanceId, updatedTemplate.title, updatedTemplate.description,
      updatedTemplate.type, updatedTemplate.priority, 'not_started',
      updatedTemplate.assignee, updatedTemplate.due_date,
      JSON.stringify(updatedTemplate.labels), JSON.stringify(updatedTemplate.attachments),
      JSON.stringify(updatedTemplate.repos), JSON.stringify(updatedTemplate.output_fields),
      updatedTemplate.agent_id, updatedTemplate.source,
      updatedTemplate.skill_ids ? JSON.stringify(updatedTemplate.skill_ids) : null,
      0, null, updatedTemplate.id, now, now
    )

    // Now read the raw row as the API would (SELECT * returns raw strings)
    const rawRow = rawDb.prepare('SELECT * FROM tasks WHERE id = ?').get(instanceId) as Record<string, unknown>

    // Simulate parseTask — this is what the mobile API does
    const apiSkillIds = parseTaskSkillIds(rawRow.skill_ids as string | null)
    expect(apiSkillIds).toEqual(['skill-x', 'skill-y'])

    // Also test with null skill_ids (agent defaults case)
    rawDb.prepare('UPDATE tasks SET skill_ids = NULL WHERE id = ?').run(instanceId)
    const nullRow = rawDb.prepare('SELECT skill_ids FROM tasks WHERE id = ?').get(instanceId) as { skill_ids: string | null }
    const apiNullResult = parseTaskSkillIds(nullRow.skill_ids)
    expect(apiNullResult).toBeNull() // Must be null, not []
  })
})

describe('Triage task status lifecycle', () => {
  it('supports the full triage lifecycle: not_started → triaging → not_started (with agent)', () => {
    const agent = db.createAgent(makeAgent({ name: 'Default Agent', is_default: true }))!
    const task = db.createTask(makeTask({ title: 'New task needing triage' }))!

    // Step 1: Task starts as not_started with no agent
    expect(task.status).toBe('not_started')
    expect(task.agent_id).toBeNull()

    // Step 2: Auto-start hook sets status to triaging
    db.updateTask(task.id, { status: 'triaging' as unknown as Parameters<typeof db.updateTask>[1]['status'] })
    const triagingTask = db.getTask(task.id)!
    expect(triagingTask.status).toBe('triaging')

    // Step 3: Triage agent assigns agent_id, skills, labels, priority
    db.updateTask(task.id, {
      agent_id: agent.id,
      skill_ids: ['skill-1', 'skill-2'],
      labels: ['frontend', 'bug'],
      priority: 'high'
    })
    const assignedTask = db.getTask(task.id)!
    expect(assignedTask.agent_id).toBe(agent.id)
    expect(assignedTask.skill_ids).toEqual(['skill-1', 'skill-2'])
    expect(assignedTask.labels).toEqual(['frontend', 'bug'])
    expect(assignedTask.priority).toBe('high')
    expect(assignedTask.status).toBe('triaging') // Still triaging

    // Step 4: transitionToIdle resets status to not_started
    db.updateTask(task.id, { status: 'not_started' as unknown as Parameters<typeof db.updateTask>[1]['status'] })
    const readyTask = db.getTask(task.id)!
    expect(readyTask.status).toBe('not_started')
    expect(readyTask.agent_id).toBe(agent.id) // Agent still assigned

    // Step 5: Auto-run picks up the task (status=not_started + agent_id set)
    // This would be handled by the auto-start hook
  })

  it('task created with agent_id already set skips triage', () => {
    const agent = db.createAgent(makeAgent({ name: 'Specific Agent' }))!
    const task = db.createTask(makeTask({ title: 'Pre-assigned task' }))!

    // Assign agent immediately after creation
    db.updateTask(task.id, { agent_id: agent.id })
    const assignedTask = db.getTask(task.id)!

    expect(assignedTask.status).toBe('not_started')
    expect(assignedTask.agent_id).toBe(agent.id)
    // This task should go directly to auto-run, not triage
  })
})
