/**
 * End-to-end tests for the in-process task-management MCP endpoint.
 *
 * A real MCP client talks to the real Task API server over HTTP. Nothing is
 * mocked between the client and the database, so these tests prove that a
 * session gets its tools without any child process.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeTask } from '../../test/helpers/task-fixtures'
import type { DatabaseManager } from './database'
import { startTaskApiServer, stopTaskApiServer, setTaskApiNotifier } from './task-api-server'
import { buildTaskMcpUrl, parseScopeFromUrl } from './task-mcp-endpoint'

let db: DatabaseManager

beforeEach(() => {
  ;({ db } = createTestDb())
})

afterEach(() => {
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

  /**
   * A client opens `GET /mcp` to listen for server-initiated messages. This
   * endpoint sends none, so the GET must be refused at once. When it is not, the
   * SDK answers with an event stream that never ends, and the request holds a
   * transport, a Server and a socket for the life of the process — one set per
   * reconnect. The stale socket also hides the real state of a session: it stays
   * ESTABLISHED long after the client dropped the tools.
   */
  it('refuses the standalone SSE stream instead of holding it open', async () => {
    const port = await startTaskApiServer(db)

    const response = await fetch(buildTaskMcpUrl(port), {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal: AbortSignal.timeout(5_000)
    })

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
    expect(response.headers.get('content-type')).not.toContain('text/event-stream')
    // The body must be complete, not a stream that waits for ever.
    await expect(response.text()).resolves.toContain('Method Not Allowed')
  })

  it('keeps answering after repeated reconnects, with no request left hanging', async () => {
    const port = await startTaskApiServer(db)
    db.createTask(makeTask({ title: 'Survivor' }))

    // Every reconnect used to leak one open GET. Ten of them, then the tools must
    // still be there and a call must still work.
    for (let i = 0; i < 10; i++) {
      const client = await connect(buildTaskMcpUrl(port))
      const names = (await client.listTools()).tools.map((t) => t.name)
      expect(names).toContain('list_tasks')
      await client.close()
    }

    const client = await connect(buildTaskMcpUrl(port))
    expect((await client.listTools()).tools).not.toHaveLength(0)
    expect(textOf(await client.callTool({ name: 'list_tasks', arguments: {} }))).toContain('Survivor')
    await client.close()
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
