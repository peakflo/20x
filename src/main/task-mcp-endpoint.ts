/**
 * In-process task-management MCP endpoint.
 *
 * Every agent session used to get its own `task-management-mcp.js` child
 * process. That child did no work of its own: it held the tool schemas and then
 * forwarded every call over HTTP to the Task API server, which already runs
 * inside this process. Dozens of those children stayed alive for days, because
 * each one lives as long as the agent CLI or the shared opencode server that
 * owns its stdin pipe.
 *
 * This endpoint replaces all of them. It serves MCP over HTTP from the Task API
 * server, so no child process starts and none can leak.
 *
 * The scope travels in the URL as plain query parameters:
 *   /mcp                                        full orchestration tool set
 *   /mcp?task=<id>&parent=<id>                  subtask set, parent + siblings only
 *   /mcp?...&artifact=<id>                      pins artifact writes to one task
 *
 * Most parameters describe task scope, but computer_cap is a bearer credential
 * for native Computer Use. The Task API server listens only on 127.0.0.1.
 *
 * Each request is handled statelessly: one transport and one Server per request.
 * That needs no session table, so a resumed agent keeps working with the same
 * URL, and nothing accumulates between calls.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { computerUseBroker } from './computer-use-broker'
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import {
  callToolForScope,
  listToolsForScope,
  type TaskApiInvoke,
  type TaskMcpScope
} from './mcp-servers/task-management-core'

/** Path that serves MCP on the Task API server. */
export const TASK_MCP_PATH = '/mcp'

/** Reads the scope of a session from the request URL. */
export function parseScopeFromUrl(url: URL): TaskMcpScope {
  const taskId = url.searchParams.get('task')
  return {
    parentTaskId: url.searchParams.get('parent') || null,
    taskId: taskId || null,
    artifactTaskId: url.searchParams.get('artifact') || taskId || null
  }
}

/**
 * Builds the MCP URL for a session. This is the whole session configuration:
 * there is no command to spawn and no port to inject into a child environment.
 */
export function buildTaskMcpUrl(
  port: number,
  scope: { taskId?: string | null; parentTaskId?: string | null; artifactTaskId?: string | null; computerToken?: string | null } = {}
): string {
  const params = new URLSearchParams()
  if (scope.taskId) params.set('task', scope.taskId)
  if (scope.parentTaskId) params.set('parent', scope.parentTaskId)
  // Only needed when it differs from `task`, which already implies it.
  if (scope.artifactTaskId && scope.artifactTaskId !== scope.taskId) {
    params.set('artifact', scope.artifactTaskId)
  }
  if (scope.computerToken) params.set('computer_cap', scope.computerToken)
  const query = params.toString()
  return `http://127.0.0.1:${port}${TASK_MCP_PATH}${query ? `?${query}` : ''}`
}

/** A fresh MCP server bound to one scope. */
function createScopedServer(scope: TaskMcpScope, invoke: TaskApiInvoke, computerToken: string | null): Server {
  const server = new Server(
    { name: 'task-management', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )
  server.setRequestHandler('tools/list', async () => ({ tools: listToolsForScope(scope) }))
  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params as { name: string; arguments?: Record<string, unknown> }
    if (name.startsWith('computer_') && !computerUseBroker.authorizesSession(scope.artifactTaskId, computerToken)) {
      return { content: [{ type: 'text' as const, text: 'Computer Use requires this task’s authorized agent session' }], isError: true }
    }
    return callToolForScope(name, args, scope, invoke)
  })
  return server
}

/** Turns a Node request plus its already-read body into a Web Request. */
function toWebRequest(req: IncomingMessage, body: string): Request {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const item of value) headers.append(key, item)
    else headers.set(key, value)
  }
  const method = req.method || 'GET'
  const host = req.headers.host || '127.0.0.1'
  return new Request(new URL(req.url || '/', `http://${host}`), {
    method,
    headers,
    // GET and HEAD must not carry a body.
    body: method === 'GET' || method === 'HEAD' || !body ? undefined : body
  })
}

/** Copies a Web Response onto the Node response, streaming the body if needed. */
async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {}
  response.headers.forEach((value, key) => {
    headers[key] = key.toLowerCase() === 'set-cookie' ? [value] : value
  })
  res.writeHead(response.status, headers)

  if (!response.body) {
    res.end()
    return
  }

  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // An SSE stream stays open, so each chunk must reach the client at once.
      res.write(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
    res.end()
  }
}

/**
 * Serves one MCP request. The caller has already read the body and matched the
 * path. Returns nothing; it writes the response itself.
 */
export async function handleTaskMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: string,
  invoke: TaskApiInvoke
): Promise<void> {
  const scope = parseScopeFromUrl(url)
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no session table, so a resumed agent keeps the same URL.
    sessionIdGenerator: undefined,
    // Plain JSON replies instead of an SSE frame per response. These tools are
    // request/response only, and no tool sends server-initiated notifications.
    enableJsonResponse: true
  })
  const server = createScopedServer(scope, invoke, url.searchParams.get('computer_cap'))

  try {
    await server.connect(transport)
    const response = await transport.handleRequest(toWebRequest(req, body))
    await writeWebResponse(response, res)
  } finally {
    await transport.close().catch(() => undefined)
    await server.close().catch(() => undefined)
  }
}
