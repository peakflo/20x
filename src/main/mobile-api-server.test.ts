import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'crypto'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeTask } from '../../test/helpers/task-fixtures'
import type { DatabaseManager } from './database'
import { startMobileApiServer, stopMobileApiServer } from './mobile-api-server'

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

  it('POST /api/tasks/:id/complete is distinct from the update route', () => {
    const completeRegex = /^\/api\/tasks\/([^/]+)\/complete$/
    const updateRegex = /^\/api\/tasks\/([^/]+)$/
    expect(completeRegex.test('/api/tasks/some-id/complete')).toBe(true)
    // The update route must NOT swallow the /complete path
    expect(updateRegex.test('/api/tasks/some-id/complete')).toBe(false)
    // And the base path must not match the complete route
    expect(completeRegex.test('/api/tasks/some-id')).toBe(false)
  })
})

describe('mobile-api-server: auth', () => {
  afterEach(() => {
    stopMobileApiServer()
    vi.restoreAllMocks()
  })

  it('starts without storing any plaintext credentials', async () => {
    const { db } = createTestDb()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await startMobileApiServer(
      db,
      {} as never,
      {} as never,
      0
    )

    // Old single-token auth is gone — no mobile_auth_token should be stored
    const legacyToken = db.getSetting('mobile_auth_token')
    expect(legacyToken).toBeFalsy()

    // No session tokens should appear in logs (sessions are created on pairing, not startup)
    const sessions = db.getMobileSessions()
    expect(sessions).toHaveLength(0)

    const logs = logSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n')
    expect(logs).toContain('[MobileAPI] Started on port')
  })
})

describe('mobile-api-server: POST /api/tasks/:id coordinator wake-up', () => {
  afterEach(() => {
    stopMobileApiServer()
    vi.restoreAllMocks()
  })

  function startServer(agentManager: unknown) {
    const { db } = createTestDb()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    // The server resolves the requested port, so pick a free-ish high port
    // instead of 0 (which would make the caller resolve port 0).
    const port = 21000 + Math.floor(Math.random() * 40000)
    return { db, logSpy, portPromise: startMobileApiServer(db, agentManager as never, {} as never, port) }
  }

  function pairToken(db: DatabaseManager): string {
    const token = 'test-pairing-token'
    const hash = createHash('sha256').update(token).digest('hex')
    db.createMobileSession('sess-1', hash, 'test-device')
    return token
  }

  it('wakes the parent coordinator when a phone moves a subtask to ready_for_review', async () => {
    const notifyParent = vi.fn().mockResolvedValue(undefined)
    const agentManager = { notifyParentOfSubtaskCompletion: notifyParent }
    const { db, portPromise } = startServer(agentManager)
    const port = await portPromise

    const parent = db.createTask(makeTask({ title: 'Parent' }))!
    const subtask = db.createTask(makeTask({ title: 'Child', parent_task_id: parent.id }))!
    db.updateTask(subtask.id, { status: 'agent_working' })

    const token = pairToken(db)
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks/${subtask.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ready_for_review' })
    })
    expect(res.status).toBe(200)

    expect(notifyParent).toHaveBeenCalledWith(parent.id, subtask.id)
  })

  it('does not wake the parent for a non-terminal or unchanged status from a phone', async () => {
    const notifyParent = vi.fn().mockResolvedValue(undefined)
    const agentManager = { notifyParentOfSubtaskCompletion: notifyParent }
    const { db, portPromise } = startServer(agentManager)
    const port = await portPromise

    const parent = db.createTask(makeTask({ title: 'Parent' }))!
    const subtask = db.createTask(makeTask({ title: 'Child', parent_task_id: parent.id }))!

    const token = pairToken(db)

    // Non-terminal transition
    await fetch(`http://127.0.0.1:${port}/api/tasks/${subtask.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'agent_working' })
    })
    expect(notifyParent).not.toHaveBeenCalled()

    // Title-only update
    await fetch(`http://127.0.0.1:${port}/api/tasks/${subtask.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'renamed' })
    })
    expect(notifyParent).not.toHaveBeenCalled()
  })
})
