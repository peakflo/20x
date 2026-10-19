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
  buildTaskMcpUrl,
  buildTaskMcpHeaders,
  parseScopeFromUrl,
  MEMORY_TOKEN_HEADER,
  sanitizeMcpUrlForDisplay,
  redactSensitiveHeaders
} from './task-mcp-endpoint'

let db: DatabaseManager

beforeEach(() => {
  ;({ db } = createTestDb())
})

afterEach(() => {
  setTaskApiNotifier(() => undefined)
  stopTaskApiServer()
})

async function connect(url: string, headers?: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), headers ? { requestInit: { headers } } : undefined))
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
      artifactTaskId: null,
      memoryToken: null
    })
  })

  it('round-trips a scoped subtask session', () => {
    const url = buildTaskMcpUrl(1234, { taskId: 'task-child', parentTaskId: 'task-parent' })
    expect(parseScopeFromUrl(new URL(url))).toEqual({
      parentTaskId: 'task-parent',
      taskId: 'task-child',
      // Artifact writes fall back to the session's own task.
      artifactTaskId: 'task-child',
      memoryToken: null
    })
  })

  // The memory token is deliberately NOT part of the URL (see
  // MEMORY_TOKEN_HEADER's doc in task-mcp-endpoint.ts): this URL is written
  // verbatim into CLAUDE.md/AGENTS.md and logged by at least one adapter, so
  // a query parameter would leak it to disk and to logs. It travels as a
  // request header instead.
  it('never puts the memory token in the URL, for any scope', () => {
    expect(buildTaskMcpUrl(1234)).not.toContain('memoryToken')
    expect(buildTaskMcpUrl(1234, { taskId: 'task-child', parentTaskId: 'task-parent' })).not.toContain('memoryToken')
  })

  it('reads the memory token from the header, not the URL', () => {
    const url = buildTaskMcpUrl(1234)
    const headers = buildTaskMcpHeaders('tok-abc123')
    expect(headers).toEqual({ [MEMORY_TOKEN_HEADER]: 'tok-abc123' })
    expect(parseScopeFromUrl(new URL(url), headers)).toEqual({
      parentTaskId: null,
      taskId: null,
      artifactTaskId: null,
      memoryToken: 'tok-abc123'
    })
  })

  it('reads the memory token together with a scoped subtask session (a trusted subtask agent)', () => {
    const url = buildTaskMcpUrl(1234, { taskId: 'task-child', parentTaskId: 'task-parent' })
    const headers = buildTaskMcpHeaders('tok-abc123')
    expect(parseScopeFromUrl(new URL(url), headers)).toEqual({
      parentTaskId: 'task-parent',
      taskId: 'task-child',
      artifactTaskId: 'task-child',
      memoryToken: 'tok-abc123'
    })
  })

  it('builds no headers at all when there is no memory token', () => {
    expect(buildTaskMcpHeaders(null)).toBeUndefined()
    expect(buildTaskMcpHeaders(undefined)).toBeUndefined()
  })

  it('ignores a memoryToken query parameter even if one is present — only the header counts', () => {
    const smuggled = new URL(buildTaskMcpUrl(1234))
    smuggled.searchParams.set('memoryToken', 'smuggled-token')
    expect(parseScopeFromUrl(smuggled).memoryToken).toBeNull()
    expect(parseScopeFromUrl(smuggled, { [MEMORY_TOKEN_HEADER]: 'real-token' }).memoryToken).toBe('real-token')
  })

  it('sanitizeMcpUrlForDisplay redacts a credential-shaped query parameter, defense in depth', () => {
    const clean = 'http://127.0.0.1:1234/mcp?task=abc'
    expect(sanitizeMcpUrlForDisplay(clean)).toBe(clean)

    const leaky = 'http://127.0.0.1:1234/mcp?task=abc&memoryToken=tok-abc123'
    const sanitized = sanitizeMcpUrlForDisplay(leaky)
    expect(sanitized).not.toContain('tok-abc123')
    expect(sanitized).toContain('task=abc')
  })

  it('redactSensitiveHeaders masks the memory token and auth-shaped headers, leaving the rest alone', () => {
    expect(redactSensitiveHeaders(undefined)).toBeUndefined()
    const redacted = redactSensitiveHeaders({
      [MEMORY_TOKEN_HEADER]: 'tok-abc123',
      Authorization: 'Bearer eyJhbGciOi...',
      'X-Custom-Header': 'harmless-value'
    })
    expect(redacted?.[MEMORY_TOKEN_HEADER]).toBe('[redacted]')
    expect(redacted?.Authorization).toBe('[redacted]')
    expect(redacted?.['X-Custom-Header']).toBe('harmless-value')
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

  it('answers the plain JSON-RPC probe that Settings uses for its status check', async () => {
    const port = await startTaskApiServer(db)
    const url = buildTaskMcpUrl(port)
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }

    const init = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pf-desktop', version: '1.0.0' } }
      })
    })
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

  // Real end-to-end proof that the memory token travels as a request header,
  // over the real HTTP transport a harness actually uses — not just a unit
  // test of parseScopeFromUrl. A URL-based `?memoryToken=` query parameter
  // would show up here as a 401 from the real server (no header sent), even
  // though the old code accepted it from the URL.
  it('grants memory tools only to a connection that sends the header, over the real HTTP transport', async () => {
    const port = await startTaskApiServer(db)
    const url = buildTaskMcpUrl(port)

    const withToken = await connect(url, buildTaskMcpHeaders('tok-e2e-123'))
    const namesWithToken = (await withToken.listTools()).tools.map((t) => t.name)
    expect(namesWithToken).toContain('remember')

    const withoutToken = await connect(url)
    const namesWithoutToken = (await withoutToken.listTools()).tools.map((t) => t.name)
    expect(namesWithoutToken).not.toContain('remember')

    await Promise.all([withToken.close(), withoutToken.close()])
  })
})
