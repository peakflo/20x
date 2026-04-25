/**
 * MCP Auth Proxy — local HTTP reverse proxy for transparent JWT refresh.
 *
 * Runs in the Electron main process, listens on 127.0.0.1:{random port}.
 * Agent MCP configs point to this proxy instead of the real remote MCP server.
 * On every forwarded request the proxy calls enterpriseAuth.getJwt() to inject
 * a fresh Authorization header, so tokens are never stale — even in sessions
 * that run for hours.
 *
 * Flow:
 *   1. Agent session starts → registerMcpProxyTarget(targetUrl)
 *   2. buildMcpServersForAdapter sets MCP url to http://127.0.0.1:<port>/<id>/…
 *   3. MCP client sends request → proxy gets fresh JWT → forwards to real server
 *   4. Real server response is piped back to MCP client unchanged
 *
 * Why:
 *   ACP, OpenCode, and Claude Code all bake MCP server headers at session start.
 *   None refresh them mid-session. A 1-hour JWT expires during long agent runs,
 *   causing persistent 401 errors on every MCP tool call with no recovery path.
 *   This proxy decouples token lifetime from session lifetime.
 */

import { createServer, request as httpRequest, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'http'
import { request as httpsRequest } from 'https'
import type { EnterpriseAuth } from './enterprise-auth'

let server: HttpServer | null = null
let port: number | null = null
let authRef: EnterpriseAuth | null = null

// Registration ID → target URL
const targets = new Map<string, string>()

// Reverse lookup: target URL → ID (deduplicates repeated registrations)
const targetsByUrl = new Map<string, string>()

// Monotonic counter for short, collision-free IDs
let nextId = 1

export function getMcpAuthProxyPort(): number | null {
  return port
}

/**
 * Register a remote MCP server URL and return a localhost proxy URL
 * that transparently injects fresh enterprise JWT on every request.
 *
 * If the same targetUrl was already registered, returns the existing
 * proxy URL (prevents leaking IDs when buildMcpServersForAdapter is
 * called on every prompt for Claude Code adapter).
 *
 * Returns null if the proxy is not running.
 */
export function registerMcpProxyTarget(targetUrl: string): string | null {
  if (!port) return null

  // Reuse existing registration for the same target URL
  const existingId = targetsByUrl.get(targetUrl)
  if (existingId) {
    return `http://127.0.0.1:${port}/${existingId}`
  }

  const id = String(nextId++)
  targets.set(id, targetUrl)
  targetsByUrl.set(targetUrl, id)
  console.log(`[McpAuthProxy] Registered target ${id} → ${targetUrl}`)
  return `http://127.0.0.1:${port}/${id}`
}

/**
 * Remove a previously registered target (cleanup on session end).
 */
export function unregisterMcpProxyTarget(proxyUrl: string): void {
  // Extract ID from proxy URL: http://127.0.0.1:<port>/<id>
  try {
    const url = new URL(proxyUrl)
    const id = url.pathname.split('/')[1]
    if (id && targets.has(id)) {
      const targetUrl = targets.get(id)!
      targets.delete(id)
      targetsByUrl.delete(targetUrl)
      console.log(`[McpAuthProxy] Unregistered target ${id}`)
    }
  } catch {
    // Ignore malformed URLs
  }
}

export function startMcpAuthProxy(auth: EnterpriseAuth): Promise<number> {
  if (server && port) return Promise.resolve(port)
  authRef = auth

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
  targetsByUrl.clear()
  authRef = null
  nextId = 1
}

// ── Request handler ───────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    // Parse: /<id>/optional/sub/path
    const reqUrl = new URL(req.url || '/', 'http://localhost')
    const pathParts = reqUrl.pathname.split('/').filter(Boolean)
    const id = pathParts[0]

    if (!id || !targets.has(id)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Unknown proxy target')
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

    // Get fresh JWT
    if (!authRef) {
      res.writeHead(503, { 'Content-Type': 'text/plain' })
      res.end('Auth not available')
      return
    }

    let jwt: string
    try {
      jwt = await authRef.getJwt()
    } catch (err) {
      console.error('[McpAuthProxy] Failed to get JWT:', err)
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Failed to obtain auth token' }))
      return
    }

    // Build forwarded headers — copy everything except host
    const forwardHeaders: Record<string, string | string[] | undefined> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() === 'host') continue
      // Skip connection-specific headers
      if (key.toLowerCase() === 'connection') continue
      forwardHeaders[key] = value
    }
    forwardHeaders['authorization'] = `Bearer ${jwt}`
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
      console.error(`[McpAuthProxy] Upstream error for target ${id}:`, err.message)
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
