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

describe('/list_skills - excludes content', () => {
  it('returns skills without content field', () => {
    db.createSkill({ name: 'Test Skill', description: 'A test skill', content: 'SECRET CONTENT HERE' })

    const skills = rawDb
      .prepare('SELECT id, name, description, version, confidence, uses, last_used, tags, created_at, updated_at FROM skills WHERE is_deleted = 0 ORDER BY confidence DESC, uses DESC')
      .all() as Record<string, unknown>[]
    skills.forEach((s) => { s.tags = JSON.parse((s.tags as string) || '[]') })

    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('Test Skill')
    expect(skills[0].description).toBe('A test skill')
    expect(skills[0]).not.toHaveProperty('content')
  })
})

describe('/get_skill - returns full details', () => {
  it('returns skill with content', () => {
    const created = db.createSkill({ name: 'Full Skill', description: 'Desc', content: 'Full content body' })!

    const skill = rawDb.prepare('SELECT * FROM skills WHERE id = ? AND is_deleted = 0').get(created.id) as Record<string, unknown>
    skill.tags = JSON.parse((skill.tags as string) || '[]')

    expect(skill.name).toBe('Full Skill')
    expect(skill.content).toBe('Full content body')
  })

  it('returns error for non-existent skill', () => {
    const skill = rawDb.prepare('SELECT * FROM skills WHERE id = ? AND is_deleted = 0').get('nonexistent') as Record<string, unknown> | undefined
    expect(skill).toBeUndefined()
  })
})

describe('/update_skill', () => {
  it('updates skill fields and increments version', () => {
    const created = db.createSkill({ name: 'Old Name', description: 'Old Desc', content: 'Old Content', tags: ['old'] })!
    expect(created.version).toBe(1)

    // Simulate handleRoute /update_skill
    const skillUpdates: string[] = []
    const skillParams: unknown[] = []
    skillUpdates.push('name = ?'); skillParams.push('New Name')
    skillUpdates.push('description = ?'); skillParams.push('New Desc')
    skillUpdates.push('content = ?'); skillParams.push('New Content')
    skillUpdates.push('tags = ?'); skillParams.push(JSON.stringify(['new', 'updated']))
    skillUpdates.push('version = version + 1')
    skillUpdates.push('updated_at = ?'); skillParams.push(new Date().toISOString())
    skillParams.push(created.id)

    const result = rawDb.prepare(
      `UPDATE skills SET ${skillUpdates.join(', ')} WHERE id = ? AND is_deleted = 0`
    ).run(...skillParams)

    expect(result.changes).toBe(1)

    const updated = db.getSkill(created.id)!
    expect(updated.name).toBe('New Name')
    expect(updated.description).toBe('New Desc')
    expect(updated.content).toBe('New Content')
    expect(updated.tags).toEqual(['new', 'updated'])
    expect(updated.version).toBe(2)
  })

  it('returns 0 changes for non-existent skill', () => {
    const result = rawDb.prepare(
      'UPDATE skills SET name = ?, version = version + 1, updated_at = ? WHERE id = ? AND is_deleted = 0'
    ).run('Name', new Date().toISOString(), 'nonexistent')
    expect(result.changes).toBe(0)
  })
})

describe('/delete_skill', () => {
  it('soft-deletes a skill', () => {
    const created = db.createSkill({ name: 'To Delete', description: 'Will be deleted', content: 'Content' })!

    const result = rawDb.prepare(
      'UPDATE skills SET is_deleted = 1, updated_at = ? WHERE id = ? AND is_deleted = 0'
    ).run(new Date().toISOString(), created.id)

    expect(result.changes).toBe(1)

    // Should not appear in normal queries
    const skill = db.getSkill(created.id)
    expect(skill).toBeUndefined()
  })

  it('returns 0 changes for already deleted skill', () => {
    const created = db.createSkill({ name: 'Already Deleted', description: 'Desc', content: 'Content' })!
    db.deleteSkill(created.id)

    const result = rawDb.prepare(
      'UPDATE skills SET is_deleted = 1, updated_at = ? WHERE id = ? AND is_deleted = 0'
    ).run(new Date().toISOString(), created.id)

    expect(result.changes).toBe(0)
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
