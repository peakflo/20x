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
import {
  buildTaskMcpHeaders,
  buildTaskMcpUrl,
  issueTaskMcpToken,
  listTaskMcpTokenOwners,
  readBearerToken,
  resolveTaskMcpToken,
  revokeTaskMcpToken,
  type TaskMcpScopeInput
} from './task-mcp-endpoint'

let db: DatabaseManager

beforeEach(() => {
  ;({ db } = createTestDb())
})

afterEach(() => {
  setTaskApiNotifier(() => undefined)
  stopTaskApiServer()
  for (const owner of listTaskMcpTokenOwners()) revokeTaskMcpToken(owner)
})

let ownerSeq = 0
/** A token for a fresh owner with the given scope. */
function tokenFor(scope: TaskMcpScopeInput = {}): string {
  return issueTaskMcpToken(`test-owner-${++ownerSeq}`, scope)
}

async function connect(port: number, scope: TaskMcpScopeInput = {}): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(buildTaskMcpUrl(port)), {
    requestInit: { headers: buildTaskMcpHeaders(tokenFor(scope)) }
  }))
  return client
}

const jsonHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
const initializeBody = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pf-desktop', version: '1.0.0' } }
})

const textOf = (result: unknown): string =>
  ((result as { content: Array<{ text: string }> }).content[0]?.text) ?? ''

describe('task-management tokens', () => {
  it('uses one fixed URL for every session, with no scope in it', () => {
    expect(buildTaskMcpUrl(1234)).toBe('http://127.0.0.1:1234/mcp')
  })

  it('binds a token to the scope of its owner', () => {
    const token = tokenFor({ taskId: 'task-child', parentTaskId: 'task-parent' })
    expect(resolveTaskMcpToken(token)).toEqual({
      parentTaskId: 'task-parent',
      taskId: 'task-child',
      // Artifact writes fall back to the session's own task.
      artifactTaskId: 'task-child'
    })
    expect(resolveTaskMcpToken(tokenFor())).toEqual({ parentTaskId: null, taskId: null, artifactTaskId: null })
  })

  it('returns the same token for the same owner, so a resume does not change the config', () => {
    const a = issueTaskMcpToken('same-owner', { taskId: 'a' })
    const b = issueTaskMcpToken('same-owner', { taskId: 'a', artifactTaskId: 'c' })
    expect(a).toBe(b)
    // The scope follows the latest call.
    expect(resolveTaskMcpToken(a)?.artifactTaskId).toBe('c')
    expect(issueTaskMcpToken('other-owner')).not.toBe(a)
  })

  it('stops resolving a token once it is revoked', () => {
    const token = issueTaskMcpToken('revoked-owner')
    expect(revokeTaskMcpToken('revoked-owner')).toBe(true)
    expect(resolveTaskMcpToken(token)).toBeNull()
    expect(revokeTaskMcpToken('revoked-owner')).toBe(false)
    // A new issue gives a new token; the old one stays dead.
    expect(issueTaskMcpToken('revoked-owner')).not.toBe(token)
    expect(resolveTaskMcpToken(token)).toBeNull()
  })

  it('reads the bearer token from the Authorization header', () => {
    expect(readBearerToken({ headers: { authorization: 'Bearer abc' } })).toBe('abc')
    expect(readBearerToken({ headers: { authorization: 'bearer abc ' } })).toBe('abc')
    expect(readBearerToken({ headers: { authorization: 'Basic abc' } })).toBeNull()
    expect(readBearerToken({ headers: {} })).toBeNull()
  })
})

describe('MCP endpoint over HTTP', () => {
  it('serves the full tool set to an unscoped session', async () => {
    const port = await startTaskApiServer(db)
    const client = await connect(port)

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

  it('answers the plain JSON-RPC probe that Settings uses for its status check', async () => {
    const port = await startTaskApiServer(db)
    const url = buildTaskMcpUrl(port)
    const headers = { ...jsonHeaders, ...buildTaskMcpHeaders(tokenFor()) }

    const init = await fetch(url, { method: 'POST', headers, body: initializeBody })
    expect(init.ok).toBe(true)
    expect(init.headers.get('content-type')).toContain('application/json')

    const list = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    })
    const body = await list.json() as { result?: { tools?: Array<{ name: string }> } }
    expect(body.result?.tools?.map((t) => t.name)).toContain('list_tasks')
  })

  it('serves the subtask tool set to a scoped session', async () => {
    const parent = db.createTask(makeTask({ title: 'Parent' }))!
    const child = db.createTask(makeTask({ title: 'Child', parent_task_id: parent.id }))!
    const port = await startTaskApiServer(db)
    const client = await connect(port, { taskId: child.id, parentTaskId: parent.id })

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
    const client = await connect(port)

    const result = await client.callTool({ name: 'get_task', arguments: { task_id: task.id } })

    expect(textOf(result)).toContain('Findable task')
    await client.close()
  })

  it('pins a scoped session to its own task on update_own_task', async () => {
    const parent = db.createTask(makeTask({ title: 'Parent' }))!
    const own = db.createTask(makeTask({ title: 'Own', parent_task_id: parent.id }))!
    const sibling = db.createTask(makeTask({ title: 'Sibling', parent_task_id: parent.id }))!
    const port = await startTaskApiServer(db)
    const client = await connect(port, { taskId: own.id, parentTaskId: parent.id })

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
    const client = await connect(port, { taskId: own.id, parentTaskId: parent.id })

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
    const client = await connect(port, { taskId: own.id, parentTaskId: parent.id })

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
    const client = await connect(port)

    const result = await client.callTool({ name: 'get_task', arguments: { task_id: 'no-such-task' } })

    expect((result as { isError?: boolean }).isError).toBe(true)
    await client.close()
  })

  it('serves two sessions with different scopes at the same time', async () => {
    const parent = db.createTask(makeTask({ title: 'Parent' }))!
    const child = db.createTask(makeTask({ title: 'Child', parent_task_id: parent.id }))!
    const port = await startTaskApiServer(db)

    const [full, scoped] = await Promise.all([
      connect(port),
      connect(port, { taskId: child.id, parentTaskId: parent.id })
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

  it('refuses a request without a token with 401', async () => {
    const port = await startTaskApiServer(db)
    const response = await fetch(buildTaskMcpUrl(port), { method: 'POST', headers: jsonHeaders, body: initializeBody })
    expect(response.status).toBe(401)
    await expect(response.text()).resolves.toContain('Unauthorized')
  })

  it('refuses an unknown token with 401', async () => {
    const port = await startTaskApiServer(db)
    const response = await fetch(buildTaskMcpUrl(port), {
      method: 'POST',
      headers: { ...jsonHeaders, ...buildTaskMcpHeaders('not-a-real-token') },
      body: initializeBody
    })
    expect(response.status).toBe(401)
  })

  it('refuses a revoked token with 401, so a leftover config stops working', async () => {
    const port = await startTaskApiServer(db)
    const token = issueTaskMcpToken('ended-session')
    const headers = { ...jsonHeaders, ...buildTaskMcpHeaders(token) }

    const before = await fetch(buildTaskMcpUrl(port), { method: 'POST', headers, body: initializeBody })
    expect(before.ok).toBe(true)

    revokeTaskMcpToken('ended-session')
    const after = await fetch(buildTaskMcpUrl(port), { method: 'POST', headers, body: initializeBody })
    expect(after.status).toBe(401)
  })

  it('does not accept a scope in the URL', async () => {
    // The old scoped URL form must not grant anything on its own.
    const port = await startTaskApiServer(db)
    const response = await fetch(`${buildTaskMcpUrl(port)}?task=x&parent=y`, {
      method: 'POST', headers: jsonHeaders, body: initializeBody
    })
    expect(response.status).toBe(401)
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
      const client = await connect(port)
      const names = (await client.listTools()).tools.map((t) => t.name)
      expect(names).toContain('list_tasks')
      await client.close()
    }

    const client = await connect(port)
    expect((await client.listTools()).tools).not.toHaveLength(0)
    expect(textOf(await client.callTool({ name: 'list_tasks', arguments: {} }))).toContain('Survivor')
    await client.close()
  })

  it('spawns no child process', async () => {
    const count = (): number =>
      Number(execSync('ps -eo command= | grep -c "[t]ask-management-mcp" || true', { encoding: 'utf-8' }).trim())

    const before = count()
    const port = await startTaskApiServer(db)
    const client = await connect(port)
    await client.listTools()
    await client.callTool({ name: 'list_tasks', arguments: {} })

    expect(count()).toBe(before)
    await client.close()
  })
})
