/**
 * MCP Auth Proxy — local HTTP reverse proxy for transparent token refresh
 * and for keeping remote-MCP Bearer tokens out of agent process argv.
 *
 * Runs in the Electron main process, listens on 127.0.0.1:{random port}.
 * Agent MCP configs point to this proxy instead of the real remote MCP server,
 * so the config object handed to each harness's SDK/CLI (which for at least
 * one harness is serialized verbatim onto its spawned process's argv — see
 * the `--mcp-config` flag in the pinned `@anthropic-ai/claude-agent-sdk`,
 * visible to any local `ps -ef`/`ps eww`) never contains a real token.
 * On every forwarded request the proxy calls a per-target token provider to
 * inject a fresh Authorization header, so tokens are never stale — even in
 * sessions that run for hours — AND never sit in a config blob that outlives
 * the request. Servers with a plain static header instead (a user-typed
 * Authorization or API-key header, no refresh needed) register that header
 * value directly with the proxy instead of a token provider — same
 * argv-exposure problem, simpler fix.
 *
 * Flow:
 *   1. Agent session starts → registerMcpProxyTarget(registrationKey, targetUrl, label, getToken)
 *   2. buildMcpServersForAdapter sets MCP url to http://127.0.0.1:<port>/<id>/…
 *   3. MCP client sends request → proxy calls getToken() → forwards to real server
 *   4. Real server response is piped back to MCP client unchanged
 *
 * Token providers:
 *   Each registration supplies its own `getToken` — the enterprise JWT
 *   (`EnterpriseAuth.getJwt`), a generic OAuth MCP server token
 *   (`OAuthManager.getValidMcpServerToken`), or any other async token getter.
 *   `startMcpAuthProxy(auth?)`'s `auth` parameter is kept only as the
 *   *default* provider for targets registered without their own `getToken`
 *   (the original enterprise-only call sites) — new callers should always
 *   pass an explicit `getToken`.
 *
 * Why:
 *   ACP, OpenCode, and Claude Code all bake MCP server headers at session start.
 *   None refresh them mid-session. A 1-hour JWT expires during long agent runs,
 *   causing persistent 401 errors on every MCP tool call with no recovery path.
 *   This proxy decouples token lifetime from session lifetime, and keeps the
 *   token out of any config that gets written to disk, logged, or passed as a
 *   CLI argument.
 */

import { createServer, request as httpRequest, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'http'
import { request as httpsRequest } from 'https'
import { randomBytes } from 'crypto'
import { Notification } from 'electron'
import type { EnterpriseAuth } from './enterprise-auth'

let server: HttpServer | null = null
let port: number | null = null
let authRef: EnterpriseAuth | null = null

// Registration ID → target URL
const targets = new Map<string, string>()

// Registration ID → human-readable integration label (e.g. "[Workflo] Organisation Workspace")
const targetLabels = new Map<string, string>()

// Registration ID → per-target async token getter. Falls back to
// `authRef.getJwt()` when a target was registered without one (legacy
// enterprise-only call sites).
const tokenProviders = new Map<string, () => Promise<string | null | undefined>>()

// Registration ID → static extra headers (e.g. a user-typed `Authorization`
// or `X-API-Key` on a plain remote MCP server that has no OAuth/enterprise
// token refresh). These are injected server-side on every forwarded request
// so the value itself never has to appear in the mcpServers config object
// handed to a harness — which for at least one harness is serialized onto
// its spawned process's argv. Merged in before any dynamic `tokenProvider`
// result, so a dynamic Authorization (OAuth/enterprise JWT) still wins if
// both are present for the same registration.
const staticHeaders = new Map<string, Record<string, string>>()

// Reverse lookup: caller-supplied registration key → ID (deduplicates
// repeated registrations from the SAME mcpServer config row across
// polling/prompt cycles). Deliberately NOT keyed by target URL: two
// different server rows (e.g. the same shared endpoint added twice, once
// per account) can share a URL while needing separate tokens — keying by
// URL would silently hand one account's requests the other's token
// (whichever registered last), a cross-account access bug.
const targetsByKey = new Map<string, string>()

// ID → the registration key it was registered under (so unregister can
// clean up targetsByKey without the caller having to remember its own key).
const keyById = new Map<string, string>()

// Track integrations that have already shown a JWT-failure notification this app run.
// Prevents spamming the user with repeated notifications for the same integration.
const notifiedJwtFailures = new Set<string>()

export function getMcpAuthProxyPort(): number | null {
  return port
}

/**
 * Register a remote MCP server and return a localhost proxy URL that
 * transparently injects a fresh Authorization header (from `getToken`, or
 * the enterprise JWT default when omitted) on every request.
 *
 * `registrationKey` identifies the MCP SERVER CONFIG ROW this registration
 * belongs to (callers pass the row's own id) — NOT the target URL. If the
 * same key was already registered, its existing proxy URL is reused
 * (prevents leaking IDs when buildMcpServersForAdapter is called on every
 * prompt). Two different rows that happen to share a target URL (the same
 * endpoint added twice under two different accounts, say) get two SEPARATE
 * registrations and tokens, never one shared one.
 *
 * Returns null if the proxy is not running.
 */
export function registerMcpProxyTarget(
  registrationKey: string,
  targetUrl: string,
  label?: string,
  getToken?: () => Promise<string | null | undefined>,
  headers?: Record<string, string>
): string | null {
  if (!port) return null

  // Reuse existing registration for the same caller-supplied key.
  const existingId = targetsByKey.get(registrationKey)
  if (existingId) {
    // Update url/label/token provider if they changed (e.g. the server's
    // URL or credential was edited, or the enterprise dev-server URL moved).
    targets.set(existingId, targetUrl)
    if (label) targetLabels.set(existingId, label)
    if (getToken) tokenProviders.set(existingId, getToken)
    // Always set (even to {}) so a header that was removed by the caller is
    // actually cleared here too, not left stale from a previous registration.
    if (headers !== undefined) staticHeaders.set(existingId, headers)
    return `http://127.0.0.1:${port}/${existingId}`
  }

  // UNGUESSABLE, not a monotonic counter. Each agent/session gets its OWN link
  // to this one proxy, and that link is how the proxy tells sessions apart and
  // attaches the right credential. `String(nextId++)` made the link guessable —
  // one agent could reach another session's target (and its token) by requesting
  // /1, /2, /3. 16 random bytes makes a link a genuine per-session capability.
  const id = randomBytes(16).toString('hex')
  targets.set(id, targetUrl)
  targetsByKey.set(registrationKey, id)
  keyById.set(id, registrationKey)
  if (label) targetLabels.set(id, label)
  if (getToken) tokenProviders.set(id, getToken)
  if (headers !== undefined) staticHeaders.set(id, headers)
  console.log(`[McpAuthProxy] Registered target ${id} (${label || 'unnamed'}) → ${targetUrl}`)
  return `http://127.0.0.1:${port}/${id}`
}

function unregisterById(id: string): void {
  if (!targets.has(id)) return
  targets.delete(id)
  const key = keyById.get(id)
  if (key) {
    targetsByKey.delete(key)
    keyById.delete(id)
  }
  targetLabels.delete(id)
  tokenProviders.delete(id)
  staticHeaders.delete(id)
  console.log(`[McpAuthProxy] Unregistered target ${id}`)
}

/**
 * Remove a previously registered target (cleanup on session end).
 */
export function unregisterMcpProxyTarget(proxyUrl: string): void {
  // Extract ID from proxy URL: http://127.0.0.1:<port>/<id>
  try {
    const url = new URL(proxyUrl)
    const id = url.pathname.split('/')[1]
    if (id) unregisterById(id)
  } catch {
    // Ignore malformed URLs
  }
}

/**
 * Same cleanup as `unregisterMcpProxyTarget`, but by the caller's own
 * `registrationKey` (the MCP server row id) instead of a proxy URL — no
 * caller currently keeps the ephemeral proxy URL around after
 * `buildMcpServersForAdapter` returns, so `unregisterMcpProxyTarget` had no
 * callers at all and every registration lived until the proxy itself
 * restarted. Call this when a session ends, for every MCP server row that
 * session's agent was configured with.
 *
 * Safe to call even when ANOTHER live session (the same agent running a
 * second concurrent task, say) still uses the same server row: that
 * session's own next `buildMcpServersForAdapter` call (every prompt
 * re-resolves MCP config) re-registers it under a fresh id — the same
 * self-healing behavior `writeLocalMcpEnvWrapper`'s per-call overwrite
 * already relies on. The only cost is a possible single forwarded request
 * failing with `unknown_proxy_target` in the narrow window between this
 * unregister and that session's next re-registration, which the MCP
 * client's own retry/reconnect handles.
 */
export function unregisterMcpProxyTargetByKey(registrationKey: string): void {
  const id = targetsByKey.get(registrationKey)
  if (id) unregisterById(id)
}

/**
 * Starts the proxy if it isn't already running. `auth`, when provided,
 * becomes the *default* token provider for targets registered without their
 * own `getToken` (legacy enterprise-only call sites). Safe to call more than
 * once — e.g. once unconditionally at app startup so OAuth-authenticated MCP
 * servers always have a proxy available, then again once enterprise auth
 * becomes available — a later call with `auth` still updates the default
 * provider even though the server is already running.
 */
export function startMcpAuthProxy(auth?: EnterpriseAuth): Promise<number> {
  if (auth) authRef = auth
  if (server && port) return Promise.resolve(port)

  return new Promise((resolve, reject) => {
    server = createServer(handleRequest)

    // Listen on random available port, loopback only
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address()
      if (typeof addr === 'object' && addr) {
        port = addr.port
        console.log(`[McpAuthProxy] Started on port ${port}`)
        resolve(port)
      } else {
        reject(new Error('Failed to get MCP auth proxy address'))
      }
    })

    server.on('error', reject)
  })
}

export function stopMcpAuthProxy(): void {
  if (server) {
    server.close()
    server = null
    port = null
  }
  targets.clear()
  targetsByKey.clear()
  keyById.clear()
  targetLabels.clear()
  tokenProviders.clear()
  staticHeaders.clear()
  notifiedJwtFailures.clear()
  authRef = null
}

// ── Request handler ───────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    // Parse: /<id>/optional/sub/path
    const reqUrl = new URL(req.url || '/', 'http://localhost')
    const pathParts = reqUrl.pathname.split('/').filter(Boolean)
    const id = pathParts[0]

    if (!id || !targets.has(id)) {
      console.warn(`[McpAuthProxy] 404 — unknown target ID "${id}"`)

      // A TERMINAL routing failure, as VALID JSON. The bare text `Unknown proxy
      // target` made the MCP client (which treats a non-2xx during connect as a
      // possible OAuth challenge and JSON.parses the body) throw
      // `SyntaxError: Unexpected identifier "Unknown"`, reported as an
      // "Invalid OAuth error response". Valid JSON removes that misdirection and
      // marks the failure non-retryable — this link is not registered with this
      // proxy, which no amount of retrying resolves.
      res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(
        JSON.stringify({
          error: 'unknown_proxy_target',
          reason: 'unknown_proxy_target',
          terminal: true,
          retryable: false,
          message:
            'MCP loopback proxy: no target is registered for this id, so this ' +
            'server is not routable for this session. Terminal routing failure ' +
            '(not authentication) — do not retry.'
        })
      )
      return
    }

    // Build the target URL: base + remaining sub-path + query string
    const targetBase = targets.get(id)!
    const subPathParts = pathParts.slice(1)
    const targetUrl = new URL(targetBase)
    if (subPathParts.length > 0) {
      // Append sub-path: /<id>/sse → targetBase + /sse
      targetUrl.pathname = targetUrl.pathname.replace(/\/$/, '') + '/' + subPathParts.join('/')
    }
    // else: no sub-path — use targetBase as-is (no trailing slash added)
    targetUrl.search = reqUrl.search

    // Get a fresh token: the target's own provider (OAuth MCP token, etc.)
    // if it registered one, else the legacy enterprise-JWT default. A
    // registration that only carries static headers (a user-typed
    // Authorization/X-API-Key, no refreshable token) has neither — that's
    // fine, it doesn't need one.
    const tokenProvider = tokenProviders.get(id) ?? (authRef ? () => authRef!.getJwt() : null)
    const extraHeaders = staticHeaders.get(id)

    if (!tokenProvider && !extraHeaders) {
      res.writeHead(503, { 'Content-Type': 'text/plain' })
      res.end('Auth not available')
      return
    }

    const integrationLabel = targetLabels.get(id) || `target ${id}`

    // Build forwarded headers — copy everything except host
    const forwardHeaders: Record<string, string | string[] | undefined> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() === 'host') continue
      // Skip connection-specific headers
      if (key.toLowerCase() === 'connection') continue
      forwardHeaders[key] = value
    }

    // Static headers (e.g. a plain API key) go in first…
    if (extraHeaders) {
      for (const [key, value] of Object.entries(extraHeaders)) {
        forwardHeaders[key.toLowerCase()] = value
      }
    }

    // …then a dynamic token (OAuth/enterprise JWT), if this registration has
    // one, overwrites any static Authorization — the refreshed token always
    // wins over a stale static value.
    if (tokenProvider) {
      let jwt: string
      try {
        const token = await tokenProvider()
        if (!token) throw new Error('No token available')
        jwt = token
      } catch (err) {
        console.error(`[McpAuthProxy] Failed to get token for "${integrationLabel}":`, err)

        // Notify the user once per integration per app run
        if (!notifiedJwtFailures.has(integrationLabel)) {
          notifiedJwtFailures.add(integrationLabel)
          try {
            new Notification({
              title: 'MCP Auth Failed',
              body: `Could not authenticate "${integrationLabel}" — please sign in again.`
            }).show()
          } catch {
            // Notification may fail in headless / test environments — ignore
          }
        }

        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Failed to obtain auth token for "${integrationLabel}"` }))
        return
      }
      forwardHeaders['authorization'] = `Bearer ${jwt}`
    }
    forwardHeaders['host'] = targetUrl.host

    // Choose http or https
    const isHttps = targetUrl.protocol === 'https:'
    const targetString = targetUrl.toString()
    const reqOptions = { method: req.method, headers: forwardHeaders }

    const callback = (proxyRes: IncomingMessage) => {
      // Forward status + headers back to MCP client
      const responseHeaders = { ...proxyRes.headers }
      // Remove transfer-encoding — Node handles chunking on the proxy→client leg.
      // But preserve it for SSE (text/event-stream) responses so events flush immediately.
      const contentType = String(proxyRes.headers['content-type'] || '')
      const isSSE = contentType.includes('text/event-stream')
      if (!isSSE) {
        delete responseHeaders['transfer-encoding']
      }

      res.writeHead(proxyRes.statusCode || 502, responseHeaders)

      if (isSSE) {
        // For SSE, flush each chunk immediately so events aren't buffered
        proxyRes.on('data', (chunk: Buffer) => {
          res.write(chunk)
        })
        proxyRes.on('end', () => res.end())
        proxyRes.on('error', () => res.end())
      } else {
        proxyRes.pipe(res)
      }
    }

    const proxyReq = isHttps
      ? httpsRequest(targetString, reqOptions, callback)
      : httpRequest(targetString, reqOptions, callback)

    proxyReq.on('error', (err) => {
      console.error(`[McpAuthProxy] Upstream error for "${integrationLabel}":`, err.message)
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Upstream error: ${err.message}` }))
      }
    })

    // Pipe request body to upstream
    req.pipe(proxyReq)
  } catch (err) {
    console.error('[McpAuthProxy] Unexpected error:', err)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('Internal proxy error')
    }
  }
}
