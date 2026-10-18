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
 * Every session uses the same URL, `/mcp`. What a session may do is carried by
 * a bearer token instead:
 *
 *   POST /mcp
 *   Authorization: Bearer <token>
 *
 * The token is random, issued by the main process for one session owner (a
 * task, the mastermind session, ...), and bound in memory to the scope of that
 * owner: full orchestration, a subtask limited to its parent and siblings, and
 * the task that owns artifact writes. A request with no token, an unknown one,
 * or a revoked one is refused with 401 before any MCP server is built.
 *
 * Why not the URL: the URL used to differ per task (`/mcp?task=..`). A fixed
 * URL makes the MCP config of a session the same shape for every task, keeps the
 * scope out of logs and documentation that print the URL, and lets the token be
 * revoked when the session ends. The token is not a strong security boundary on
 * its own: the plain Task API routes on this same 127.0.0.1 server still have no
 * authentication. It binds a session to its own scope and makes a leftover
 * config (an old opencode.json, a dropped session) stop working once revoked.
 *
 * Each request is handled statelessly: one transport and one Server per request.
 * That needs no session table, so a resumed agent keeps working with the same
 * token, and nothing accumulates between calls.
 *
 * The endpoint answers on POST only. A GET asks for the standalone stream of
 * server-initiated messages, and these tools never send one, so the GET is
 * refused with 405 before a transport exists. See handleTaskMcpRequest.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import {
  callToolForScope,
  listToolsForScope,
  type TaskApiInvoke,
  type TaskMcpScope
} from './mcp-servers/task-management-core'

/** Path that serves MCP on the Task API server. */
export const TASK_MCP_PATH = '/mcp'

type TokenGrant = { owner: string; scope: TaskMcpScope }

/** token -> grant. In memory only: a restart of the app revokes every token. */
const grants = new Map<string, TokenGrant>()
/** owner -> token, so every config built for one owner carries the same token. */
const ownerTokens = new Map<string, string>()

/** The scope of a session, as the main process knows it. */
export type TaskMcpScopeInput = {
  taskId?: string | null
  parentTaskId?: string | null
  artifactTaskId?: string | null
}

function toScope(input: TaskMcpScopeInput): TaskMcpScope {
  const taskId = input.taskId || null
  return {
    parentTaskId: input.parentTaskId || null,
    taskId,
    artifactTaskId: input.artifactTaskId || taskId
  }
}

/**
 * Returns the token of a session owner, issuing a random one on first use.
 *
 * The same owner always gets the same token until it is revoked. A session
 * config is rebuilt on every resume and on every status check, and a new token
 * each time would change the config and make the agent re-attach the server
 * for nothing. The scope is refreshed on every call, so a task that changed
 * parent is served with its current scope.
 */
export function issueTaskMcpToken(owner: string, scope: TaskMcpScopeInput = {}): string {
  const existing = ownerTokens.get(owner)
  if (existing) {
    grants.set(existing, { owner, scope: toScope(scope) })
    return existing
  }
  const token = randomBytes(32).toString('base64url')
  grants.set(token, { owner, scope: toScope(scope) })
  ownerTokens.set(owner, token)
  return token
}

/** Revokes the token of an owner. Returns whether there was one. */
export function revokeTaskMcpToken(owner: string): boolean {
  const token = ownerTokens.get(owner)
  if (!token) return false
  ownerTokens.delete(owner)
  grants.delete(token)
  return true
}

/** The scope a token grants, or null when the token is unknown or revoked. */
export function resolveTaskMcpToken(token: string | null | undefined): TaskMcpScope | null {
  if (!token) return null
  return grants.get(token)?.scope ?? null
}

/** Owners that hold a live token. For tests and diagnostics. */
export function listTaskMcpTokenOwners(): string[] {
  return [...ownerTokens.keys()]
}

/** Reads `Authorization: Bearer <token>` from a request. */
export function readBearerToken(req: Pick<IncomingMessage, 'headers'>): string | null {
  const header = req.headers.authorization
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return null
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value)
  return match ? match[1] : null
}

/**
 * The MCP URL. It is the same for every session: the scope travels in the
 * bearer token (see issueTaskMcpToken), never in the URL.
 */
export function buildTaskMcpUrl(port: number): string {
  return `http://127.0.0.1:${port}${TASK_MCP_PATH}`
}

/** The headers that authenticate a session on the endpoint. */
export function buildTaskMcpHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

/** A fresh MCP server bound to one scope. */
function createScopedServer(scope: TaskMcpScope, invoke: TaskApiInvoke): Server {
  const server = new Server(
    { name: 'task-management', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )
  server.setRequestHandler('tools/list', async () => ({ tools: listToolsForScope(scope) }))
  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params as { name: string; arguments?: Record<string, unknown> }
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
  body: string,
  invoke: TaskApiInvoke
): Promise<void> {
  // Refuse the standalone SSE stream before a transport is ever built.
  //
  // A client opens `GET /mcp` to listen for server-initiated messages. These
  // tools never send any: every reply belongs to the request that asked for it,
  // which is why `enableJsonResponse` is on. The MCP spec lets a server that has
  // nothing to push answer such a GET with 405, and it must.
  //
  // Left to itself the SDK does the opposite. In stateless mode
  // `handleGetRequest` still hands back a `text/event-stream` body that stays
  // open for ever, so the copy loop below never reaches `done`, the `finally`
  // never runs, and the request keeps one transport, one Server and one socket
  // alive for the life of the process — one set per client reconnect. Since
  // @modelcontextprotocol/server v2 that stream also arms a keep-alive interval,
  // so a leaked one now holds a live timer too. That idle socket is also what
  // makes a dropped session look healthy from the outside: the connection is
  // still ESTABLISHED long after the client stopped using it.
  const method = req.method || 'GET'
  if (method === 'GET' || method === 'DELETE') {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' })
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method Not Allowed: this endpoint answers on POST only' },
      id: null
    }))
    return
  }

  // Authenticate before a transport exists, so a refused request costs nothing.
  const scope = resolveTaskMcpToken(readBearerToken(req))
  if (!scope) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized: missing, unknown or revoked task-management token' },
      id: null
    }))
    return
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no session table, so a resumed agent keeps working with its token.
    sessionIdGenerator: undefined,
    // Plain JSON replies instead of an SSE frame per response. These tools are
    // request/response only, and no tool sends server-initiated notifications.
    enableJsonResponse: true
  })
  const server = createScopedServer(scope, invoke)

  try {
    await server.connect(transport)
    const response = await transport.handleRequest(toWebRequest(req, body))
    await writeWebResponse(response, res)
  } finally {
    await transport.close().catch(() => undefined)
    await server.close().catch(() => undefined)
  }
}
