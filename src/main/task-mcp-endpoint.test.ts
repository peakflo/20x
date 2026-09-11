/**
 * End-to-end tests for the in-process task-management MCP endpoint.
 *
 * A real MCP client talks to the real Task API server over HTTP. Nothing is
 * mocked between the client and the database, so these tests prove that a
 * session gets its tools without any child process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execSync } from 'child_process'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeTask } from '../../test/helpers/task-fixtures'
import type { DatabaseManager } from './database'
import { startTaskApiServer, stopTaskApiServer, setTaskApiNotifier, setTaskControl } from './task-api-server'
import { TaskControl } from './task-control'
import { RecurrenceScheduler } from './recurrence-scheduler'
import type { ResponsibilityManager } from './responsibility-manager'
import { buildTaskMcpUrl, parseScopeFromUrl } from './task-mcp-endpoint'

let db: DatabaseManager

beforeEach(() => {
  ;({ db } = createTestDb())
})

afterEach(() => {
  setTaskControl(undefined)
  setTaskApiNotifier(() => undefined)
  stopTaskApiServer()
})

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

const textOf = (result: unknown): string =>
  ((result as { content: Array<{ text: string }> }).content[0]?.text) ?? ''

describe('buildTaskMcpUrl and parseScopeFromUrl', () => {
  it('round-trips a full-access session', () => {
    const url = buildTaskMcpUrl(1234)
    expect(url).toBe('http://127.0.0.1:1234/mcp')
    expect(parseScopeFromUrl(new URL(url))).toEqual({
      parentTaskId: null,
      taskId: null,
      artifactTaskId: null
    })
  })

  it('round-trips a scoped subtask session', () => {
    const url = buildTaskMcpUrl(1234, { taskId: 'task-child', parentTaskId: 'task-parent' })
    expect(parseScopeFromUrl(new URL(url))).toEqual({
      parentTaskId: 'task-parent',
      taskId: 'task-child',
      // Artifact writes fall back to the session's own task.
      artifactTaskId: 'task-child'
    })
  })

  it('carries a separate artifact scope only when it differs from the task', () => {
    expect(buildTaskMcpUrl(1, { taskId: 't', artifactTaskId: 't' })).not.toContain('artifact=')
    const url = buildTaskMcpUrl(1, { taskId: 't', parentTaskId: 'p', artifactTaskId: 'other' })
    expect(parseScopeFromUrl(new URL(url)).artifactTaskId).toBe('other')
  })

  it('builds the same URL every time, so a resume does not change the config', () => {
    const scope = { taskId: 'a', parentTaskId: 'b', artifactTaskId: 'c' }
    expect(buildTaskMcpUrl(9, scope)).toBe(buildTaskMcpUrl(9, scope))
  })
})

describe('MCP endpoint over HTTP', () => {
  it('defaults new MCP schedules to reuse and confirms conversion without changing their paused state', async () => {
    const responsibilities = { projectForTask: () => undefined } as unknown as ResponsibilityManager
    const confirm = vi.fn(async () => true)
    const service = new TaskControl(db, { withStoppedTasks: vi.fn() }, { completeTask: vi.fn() }, responsibilities, confirm, vi.fn(), new RecurrenceScheduler(db))
    setTaskControl(service)
    const port = await startTaskApiServer(db)
    const client = await connect(buildTaskMcpUrl(port, { artifactTaskId: 'mastermind-session' }))
    try {
      const created = JSON.parse(textOf(await client.callTool({ name: 'create_task', arguments: { title: 'Repeated check', cron: '*/5 * * * *', auto_complete_without_review: true } })))
      const id = created.task.id
      expect(db.getTask(id)).toMatchObject({ recurrence_mode: 'reuse', auto_complete_without_review: false })
      const manage = async (action: string) => JSON.parse(textOf(await client.callTool({ name: 'manage_task', arguments: { task_id: id, action } })))
      expect(await manage('separate_schedule')).toMatchObject({ error: expect.stringContaining('paused') })
      expect(await manage('pause_schedule')).toMatchObject({ success: true })
      confirm.mockResolvedValueOnce(false)
      expect(await manage('separate_schedule')).toMatchObject({ cancelled: true })
      expect(db.getTask(id)?.recurrence_mode).toBe('reuse')
      expect(await manage('separate_schedule')).toMatchObject({ success: true, mode: 'separate', schedulePaused: true })
      expect(await manage('reuse_schedule')).toMatchObject({ success: true, mode: 'reuse', schedulePaused: true })
      expect(JSON.parse(textOf(await client.callTool({ name: 'inspect_tasks', arguments: { task_id: id, runs: true } })))).toEqual([])
    } finally { await client.close(); await service.stop() }
  })

  it('pauses and resumes the exact recurring template through Mastermind, preserving runs and settings', async () => {
    const task = db.createTask(makeTask({ title: 'Slack monitor', is_recurring: true, recurrence_pattern: '*/5 * * * *', auto_start_agent: true }))!
    const instance = db.createTask(makeTask({ title: task.title, recurrence_parent_id: task.id }))!
    const responsibilities = { projectForTask: () => undefined } as unknown as ResponsibilityManager
    const confirm = vi.fn(async () => true)
    const stop = vi.fn()
    const service = new TaskControl(db, { withStoppedTasks: stop }, { completeTask: vi.fn() }, responsibilities, confirm, vi.fn(), new RecurrenceScheduler(db))
    setTaskControl(service)
    const port = await startTaskApiServer(db)
    const client = await connect(buildTaskMcpUrl(port, { artifactTaskId: 'mastermind-session' }))
    try {
      const matches = JSON.parse(textOf(await client.callTool({ name: 'inspect_tasks', arguments: { query: 'Slack monitor' } })))
      expect(matches).toEqual(expect.arrayContaining([expect.objectContaining({ id: task.id, schedule: { pattern: '*/5 * * * *', mode: 'separate', paused: false, nextAt: null } })]))
      const manage = async (action: string, taskId = task.id) => JSON.parse(textOf(await client.callTool({ name: 'manage_task', arguments: { task_id: taskId, action } })))
      expect(await manage('pause_schedule', instance.id)).toMatchObject({ error: expect.stringContaining('template') })
      expect(confirm).not.toHaveBeenCalled()
      confirm.mockResolvedValueOnce(false)
      expect(await manage('pause_schedule')).toMatchObject({ success: false, cancelled: true })
      expect(db.getTask(task.id)?.recurrence_paused).toBe(false)
      expect(await manage('pause_schedule')).toMatchObject({ success: true, schedulePaused: true, nextOccurrenceAt: null })
      expect(await manage('pause_schedule')).toMatchObject({ success: true, schedulePaused: true })
      expect(confirm).toHaveBeenCalledTimes(2)
      confirm.mockImplementationOnce(async () => { db.updateTask(task.id, { recurrence_pattern: '*/10 * * * *' }); return true })
      expect(await manage('resume_schedule')).toMatchObject({ error: expect.stringContaining('changed') })
      expect(db.getTask(task.id)?.recurrence_paused).toBe(true)
      expect(await manage('resume_schedule')).toMatchObject({ success: true, schedulePaused: false, existingRunsUnchanged: true })
      expect(Date.parse(db.getTask(task.id)!.next_occurrence_at!)).toBeGreaterThan(Date.now())
      expect(db.getTask(task.id)).toMatchObject({ is_recurring: true, auto_start_agent: true, recurrence_pattern: '*/10 * * * *' })
      expect(db.getTask(instance.id)).toEqual(instance)
      expect(stop).not.toHaveBeenCalled()
    } finally { await client.close(); await service.stop() }
  })

  it('runs Mastermind task inspection and confirmed deletion through the real MCP endpoint', async () => {
    const task = db.createTask(makeTask({ title: 'Disposable test task' }))!
    const second = db.createTask(makeTask({ title: 'Second disposable task' }))!
    vi.spyOn(db, 'deleteTaskAttachments').mockImplementation(() => {})
    const responsibilities = { projectForTask: () => undefined, stepForTask: () => undefined, snapshot: () => ({ responsibilities: [] }) } as unknown as ResponsibilityManager
    const confirm = vi.fn(async () => true)
    const service = new TaskControl(db, { withStoppedTasks: async (_ids, action) => action() }, { completeTask: vi.fn() }, responsibilities, confirm, vi.fn())
    setTaskControl(service)
    const port = await startTaskApiServer(db)
    const client = await connect(buildTaskMcpUrl(port, { artifactTaskId: 'mastermind-session' }))
    try {
      expect((await client.listTools()).tools.map(t => t.name)).toContain('manage_task')
      expect(textOf(await client.callTool({ name: 'inspect_tasks', arguments: { query: task.title } }))).toContain(task.id)
      const result = await client.callTool({ name: 'manage_task', arguments: { task_ids: [task.id, second.id], action: 'delete' } })
      expect(JSON.parse(textOf(result))).toMatchObject({ success: true, deletedTaskIds: [task.id, second.id] })
      expect(confirm).toHaveBeenCalledOnce()
      expect(db.getTask(task.id)).toBeUndefined()
      expect(db.getTask(second.id)).toBeUndefined()
    } finally { await client.close(); await service.stop() }
  })

  it('serves the full tool set to an unscoped session', async () => {
    const port = await startTaskApiServer(db)
    const client = await connect(buildTaskMcpUrl(port))

    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)

    expect(names).toContain('list_tasks')
    expect(names).toContain('create_task')
    expect(names).toContain('create_subtask')
    // Scoped-only tools must not appear.
    expect(names).not.toContain('get_parent_task')
    expect(names).not.toContain('get_own_task')

    await client.close()
  })

  it('serves the subtask tool set to a scoped session', async () => {
    const parent = db.createTask(makeTask({ title: 'Parent' }))!
    const child = db.createTask(makeTask({ title: 'Child', parent_task_id: parent.id }))!
    const port = await startTaskApiServer(db)
    const client = await connect(buildTaskMcpUrl(port, { taskId: child.id, parentTaskId: parent.id }))

    const names = (await client.listTools()).tools.map((t) => t.name)

    expect(names).toContain('get_parent_task')
    expect(names).toContain('get_own_task')
    expect(names).toContain('list_sibling_subtasks')
    // A subtask agent must not be able to create or list arbitrary tasks.
    expect(names).not.toContain('create_task')
    expect(names).not.toContain('list_tasks')

    await client.close()
  })

  it('reads real data from the database through tools/call', async () => {
    const task = db.createTask(makeTask({ title: 'Findable task' }))!
    const port = await startTaskApiServer(db)
    const client = await connect(buildTaskMcpUrl(port))

    const result = await client.callTool({ name: 'get_task', arguments: { task_id: task.id } })

    expect(textOf(result)).toContain('Findable task')
    await client.close()
  })

  it('pins a scoped session to its own task on update_own_task', async () => {
    const parent = db.createTask(makeTask({ title: 'Parent' }))!
    const own = db.createTask(makeTask({ title: 'Own', parent_task_id: parent.id }))!
    const sibling = db.createTask(makeTask({ title: 'Sibling', parent_task_id: parent.id }))!
    const port = await startTaskApiServer(db)
    const client = await connect(buildTaskMcpUrl(port, { taskId: own.id, parentTaskId: parent.id }))

    // The agent names its sibling. The scope rewrites the target to its own task.
    await client.callTool({
      name: 'update_own_task',
      arguments: { task_id: sibling.id, description: 'changed by scoped agent' }
    })

    expect(db.getTask(own.id)?.description).toBe('changed by scoped agent')
    expect(db.getTask(sibling.id)?.description).not.toBe('changed by scoped agent')
    await client.close()
  })

  it('blocks a tool that the scope does not advertise', async () => {
    // Regression test for a scope escape: the scoped dispatch ended in a
    // pass-through, so `update_task` reached the unscoped route and could change
    // any task in the database, even though it is not in the subtask tool list.
    const parent = db.createTask(makeTask({ title: 'Parent' }))!
    const own = db.createTask(makeTask({ title: 'Own', parent_task_id: parent.id }))!
    const stranger = db.createTask(makeTask({ title: 'Stranger' }))!
    const port = await startTaskApiServer(db)
    const client = await connect(buildTaskMcpUrl(port, { taskId: own.id, parentTaskId: parent.id }))

    const result = await client.callTool({
      name: 'update_task',
      arguments: { task_id: stranger.id, description: 'escaped the scope' }
    })

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(db.getTask(stranger.id)?.description).not.toBe('escaped the scope')
    expect(db.getTask(own.id)?.description).not.toBe('escaped the scope')
    await client.close()
  })

  it('refuses a task that is not a sibling', async () => {
    const parent = db.createTask(makeTask({ title: 'Parent' }))!
    const own = db.createTask(makeTask({ title: 'Own', parent_task_id: parent.id }))!
    const stranger = db.createTask(makeTask({ title: 'Stranger' }))!
    const port = await startTaskApiServer(db)
    const client = await connect(buildTaskMcpUrl(port, { taskId: own.id, parentTaskId: parent.id }))

    const result = await client.callTool({
      name: 'get_sibling_task',
      arguments: { task_id: stranger.id }
    })

    expect(textOf(result)).toContain('Access denied')
    expect(textOf(result)).not.toContain('Stranger')
    await client.close()
  })

  it('reports a failing tool call as an error instead of throwing', async () => {
    const port = await startTaskApiServer(db)
    const client = await connect(buildTaskMcpUrl(port))

    const result = await client.callTool({ name: 'get_task', arguments: { task_id: 'no-such-task' } })

    expect((result as { isError?: boolean }).isError).toBe(true)
    await client.close()
  })

  it('serves two sessions with different scopes at the same time', async () => {
    const parent = db.createTask(makeTask({ title: 'Parent' }))!
    const child = db.createTask(makeTask({ title: 'Child', parent_task_id: parent.id }))!
    const port = await startTaskApiServer(db)

    const [full, scoped] = await Promise.all([
      connect(buildTaskMcpUrl(port)),
      connect(buildTaskMcpUrl(port, { taskId: child.id, parentTaskId: parent.id }))
    ])
    const [fullNames, scopedNames] = await Promise.all([
      full.listTools().then((r) => r.tools.map((t) => t.name)),
      scoped.listTools().then((r) => r.tools.map((t) => t.name))
    ])

    // One process, two tool sets — the point of the change.
    expect(fullNames).toContain('list_tasks')
    expect(scopedNames).not.toContain('list_tasks')
    expect(scopedNames).toContain('get_own_task')

    await Promise.all([full.close(), scoped.close()])
  })

  it('spawns no child process', async () => {
    const count = (): number =>
      Number(execSync('ps -eo command= | grep -c "[t]ask-management-mcp" || true', { encoding: 'utf-8' }).trim())

    const before = count()
    const port = await startTaskApiServer(db)
    const client = await connect(buildTaskMcpUrl(port))
    await client.listTools()
    await client.callTool({ name: 'list_tasks', arguments: {} })

    expect(count()).toBe(before)
    await client.close()
  })
})
