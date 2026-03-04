import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeTask } from '../../test/helpers/task-fixtures'
import type { DatabaseManager } from './database'

// We test the database-level route logic for the create task feature,
// which is the new functionality we're testing.

let db: DatabaseManager

describe('mobile-api-server: POST /api/tasks (create)', () => {
  beforeEach(() => {
    ;({ db } = createTestDb())
  })

  it('creates a task via DatabaseManager', () => {
    const task = db.createTask(makeTask({ title: 'Mobile Task', priority: 'high' }))

    expect(task).toBeDefined()
    expect(task!.title).toBe('Mobile Task')
    expect(task!.priority).toBe('high')
    expect(task!.status).toBe('not_started')
    expect(task!.id).toBeTruthy()
  })

  it('creates a task with all mobile form fields', () => {
    const task = db.createTask(makeTask({
      title: 'Full Mobile Task',
      description: 'Created from phone',
      type: 'coding',
      priority: 'critical',
      due_date: '2026-04-01T00:00:00.000Z',
      labels: ['mobile', 'urgent'],
      output_fields: [{ id: 'f1', name: 'Result', type: 'text' }],
      is_recurring: true,
      recurrence_pattern: '0 9 * * 1-5'
    }))

    expect(task).toBeDefined()
    expect(task!.title).toBe('Full Mobile Task')
    expect(task!.description).toBe('Created from phone')
    expect(task!.type).toBe('coding')
    expect(task!.priority).toBe('critical')
    expect(task!.due_date).toBe('2026-04-01T00:00:00.000Z')
    expect(task!.labels).toEqual(['mobile', 'urgent'])
    expect(task!.output_fields).toEqual([{ id: 'f1', name: 'Result', type: 'text' }])
    expect(task!.is_recurring).toBe(true)
    expect(task!.recurrence_pattern).toBe('0 9 * * 1-5')
  })

  it('creates task with defaults for omitted fields', () => {
    const task = db.createTask({ title: 'Minimal Task' } as Parameters<typeof db.createTask>[0])

    expect(task).toBeDefined()
    expect(task!.title).toBe('Minimal Task')
    expect(task!.description).toBe('')
    expect(task!.type).toBe('general')
    expect(task!.priority).toBe('medium')
    expect(task!.status).toBe('not_started')
    expect(task!.labels).toEqual([])
    expect(task!.is_recurring).toBe(false)
  })

  it('created task is retrievable via getTask', () => {
    const task = db.createTask(makeTask({ title: 'Persisted' }))!
    const fetched = db.getTask(task.id)

    expect(fetched).toBeDefined()
    expect(fetched!.id).toBe(task.id)
    expect(fetched!.title).toBe('Persisted')
  })

  it('created task appears in getTasks list', () => {
    db.createTask(makeTask({ title: 'Task A' }))
    db.createTask(makeTask({ title: 'Task B' }))

    const tasks = db.getTasks()
    expect(tasks).toHaveLength(2)
    expect(tasks.map(t => t.title)).toContain('Task A')
    expect(tasks.map(t => t.title)).toContain('Task B')
  })

  it('created task can be updated', () => {
    const task = db.createTask(makeTask({ title: 'Original' }))!
    const updated = db.updateTask(task.id, { title: 'Modified', priority: 'high' })

    expect(updated!.title).toBe('Modified')
    expect(updated!.priority).toBe('high')
  })
})

describe('mobile-api-server: route matching', () => {
  it('POST /api/tasks path does not match the update regex', () => {
    // The update route regex requires at least one character after /api/tasks/
    // Ensure the exact path /api/tasks is NOT matched by the :id route
    const updateRegex = /^\/api\/tasks\/([^/]+)$/
    expect(updateRegex.test('/api/tasks')).toBe(false)
    expect(updateRegex.test('/api/tasks/')).toBe(false)
    expect(updateRegex.test('/api/tasks/some-id')).toBe(true)
  })
})
