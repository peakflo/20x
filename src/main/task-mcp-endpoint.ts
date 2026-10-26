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
 * `task`/`parent`/`artifact` are an address, not a credential — the Task API
 * server they reach has no authentication, and it listens only on
 * 127.0.0.1.
 *
 * The one exception is the memory token (see TaskMcpScope.memoryToken and
 * task-api-server.ts's requireMemoryToken): it IS a credential. Memory is
 * auto-injected into Mastermind's context on every session, so unlike the
 * others, a caller must prove it was actually granted memory access before a
 * /remember etc. call is allowed to do anything — the tool list alone is not
 * enforcement, since every route here is also reachable by a plain HTTP POST
 * that skips the tool list entirely.
 *
 * Deliberately NOT a URL query parameter, unlike the others above: this URL
 * is written verbatim into each session's CLAUDE.md/AGENTS.md documentation
 * (see AgentManager.describeMcpTransport) and logged by at least one adapter
 * on every MCP registration (OpencodeAdapter.registerMcpServers). A query
 * parameter would leak the token to disk and to logs, readable by any
 * process in the workspace — undoing the whole point of gating memory
 * access to trusted sessions. Instead it travels as the `MEMORY_TOKEN_HEADER`
 * request header, which is never written to either: the adapters resolve
 * `McpServerConfig.headers` into their harness's own MCP transport config
 * (Claude Agent SDK, OpenCode's mcp.add, Codex's http_headers, ACP's
 * `headers` array) without ever logging or persisting it in the human-facing
 * docs. The token itself still travels the same way the secret broker's does
 * (secret-broker.ts): a random value over loopback HTTP, matching this
 * server's existing trust model.
 *
 * Each request is handled statelessly: one transport and one Server per request.
 * That needs no session table, so a resumed agent keeps working with the same
 * URL, and nothing accumulates between calls.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import {
  callToolForScope,
  listToolsForScope,
  type TaskApiInvoke,
  type TaskMcpScope
} from './mcp-servers/task-management-core'

/** Path that serves MCP on the Task API server. */
export const TASK_MCP_PATH = '/mcp'

/**
 * Header that carries the memory token — see the module doc above for why
 * this is a header and not a query parameter. Lowercase, matching how Node
 * normalizes incoming request header names.
 */
export const MEMORY_TOKEN_HEADER = 'x-mastermind-memory-token'

/** Reads a header case-insensitively from either a Node `IncomingMessage`
 * header map or a Web `Headers` object. */
function readHeader(headers: IncomingMessage['headers'] | Headers, name: string): string | null {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name)
  const value = (headers as IncomingMessage['headers'])[name]
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

/**
 * Reads the scope of a session from the request URL and headers. The memory
 * token is deliberately never read from the URL — see MEMORY_TOKEN_HEADER.
 */
export function parseScopeFromUrl(url: URL, headers: IncomingMessage['headers'] | Headers = {}): TaskMcpScope {
  const taskId = url.searchParams.get('task')
  return {
    parentTaskId: url.searchParams.get('parent') || null,
    taskId: taskId || null,
    artifactTaskId: url.searchParams.get('artifact') || taskId || null,
    memoryToken: readHeader(headers, MEMORY_TOKEN_HEADER)
  }
}

/**
 * Builds the MCP URL for a session. This is the whole session configuration
 * besides the memory token (see buildTaskMcpHeaders): there is no command to
 * spawn and no port to inject into a child environment.
 */
export function buildTaskMcpUrl(
  port: number,
  scope: { taskId?: string | null; parentTaskId?: string | null; artifactTaskId?: string | null } = {}
): string {
  const params = new URLSearchParams()
  if (scope.taskId) params.set('task', scope.taskId)
  if (scope.parentTaskId) params.set('parent', scope.parentTaskId)
  // Only needed when it differs from `task`, which already implies it.
  if (scope.artifactTaskId && scope.artifactTaskId !== scope.taskId) {
    params.set('artifact', scope.artifactTaskId)
  }
  const query = params.toString()
  return `http://127.0.0.1:${port}${TASK_MCP_PATH}${query ? `?${query}` : ''}`
}

/**
 * Builds the header set for a session's memory token, or `undefined` when
 * there is none — ready to assign straight to `McpServerConfig.headers`.
 */
export function buildTaskMcpHeaders(memoryToken?: string | null): Record<string, string> | undefined {
  return memoryToken ? { [MEMORY_TOKEN_HEADER]: memoryToken } : undefined
}

/** Header names whose values must never be written to a log line or an
 * on-disk doc. The memory token exactly, plus the common auth header shapes
 * this process also injects into remote MCP configs (OAuth bearer tokens,
 * enterprise JWTs) — belt and suspenders for whatever logs or documents a
 * raw MCP server config next to its headers. */
function isSensitiveHeaderName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === MEMORY_TOKEN_HEADER || lower === 'authorization' || lower.includes('token') || lower.includes('secret')
}

/**
 * Redacts header values that must never reach a log line or an on-disk doc —
 * returns a shallow copy with sensitive values masked. Use this at every
 * place that logs or documents an MCP server's headers (e.g.
 * OpencodeAdapter.registerMcpServers' registration log).
 */
export function redactSensitiveHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return headers
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isSensitiveHeaderName(name) ? '[redacted]' : value
  }
  return out
}

/**
 * Strips any credential-shaped query parameter from a URL before it is
 * written to a doc or a log line. Defense in depth: nothing should put
 * `memoryToken` (or anything else credential-shaped) in a URL anymore — it
 * travels as a header instead — but this makes a future regression harmless
 * instead of a leak, regardless of where that URL came from.
 */
export function sanitizeMcpUrlForDisplay(url: string): string {
  try {
    const parsed = new URL(url)
    let changed = false
    for (const key of [...parsed.searchParams.keys()]) {
      if (isSensitiveHeaderName(key)) {
        parsed.searchParams.set(key, '[redacted]')
        changed = true
      }
    }
    return changed ? parsed.toString() : url
  } catch {
    return url
  }
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
  url: URL,
  body: string,
  invoke: TaskApiInvoke
): Promise<void> {
  const scope = parseScopeFromUrl(url, req.headers)
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no session table, so a resumed agent keeps the same URL.
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
