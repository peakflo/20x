import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'http'

// Track Notification calls
const mockNotificationShow = vi.fn()
const mockNotificationConstructor = vi.fn()

// Mock electron before importing the module
vi.mock('electron', () => ({
  app: { isPackaged: false },
  Notification: function MockNotification(opts: { title: string; body: string }) {
    mockNotificationConstructor(opts)
    return { show: mockNotificationShow }
  }
}))

// We test the proxy by starting both it and a mock upstream server
import {
  startMcpAuthProxy,
  stopMcpAuthProxy,
  registerMcpProxyTarget,
  unregisterMcpProxyTarget,
  getMcpAuthProxyPort
} from './mcp-auth-proxy'

// ── Mock EnterpriseAuth ───────────────────────────────────────────

class MockAuth {
  private callCount = 0
  private jwtValue = 'jwt-token-1'
  private shouldFail = false

  async getJwt(): Promise<string> {
    this.callCount++
    if (this.shouldFail) throw new Error('Auth failed')
    return this.jwtValue
  }

  setJwt(value: string): void {
    this.jwtValue = value
  }

  setFail(fail: boolean): void {
    this.shouldFail = fail
  }

  getCallCount(): number {
    return this.callCount
  }
}

// ── Mock upstream MCP server ──────────────────────────────────────

function createMockUpstream(): Promise<{ server: HttpServer; port: number; lastHeaders: () => Record<string, string | string[] | undefined>; lastBody: () => string; lastMethod: () => string; lastUrl: () => string }> {
  let capturedHeaders: Record<string, string | string[] | undefined> = {}
  let capturedBody = ''
  let capturedMethod = ''
  let capturedUrl = ''

  return new Promise((resolve) => {
    const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
      capturedHeaders = { ...req.headers }
      capturedMethod = req.method || ''
      capturedUrl = req.url || ''

      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        capturedBody = Buffer.concat(chunks).toString()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ result: 'ok', method: capturedMethod }))
      })
    })

    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const p = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        server: srv,
        port: p,
        lastHeaders: () => capturedHeaders,
        lastBody: () => capturedBody,
        lastMethod: () => capturedMethod,
        lastUrl: () => capturedUrl
      })
    })
  })
}

// ── Tests ─────────────────────────────────────────────────────────

describe('MCP Auth Proxy', () => {
  let mockAuth: MockAuth
  let upstream: Awaited<ReturnType<typeof createMockUpstream>>

  beforeEach(async () => {
    mockAuth = new MockAuth()
    upstream = await createMockUpstream()
    mockNotificationShow.mockClear()
    mockNotificationConstructor.mockClear()
  })

  afterEach(async () => {
    stopMcpAuthProxy()
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()))
  })

  it('starts on a random port and reports it', async () => {
    const port = await startMcpAuthProxy(mockAuth as never)
    expect(port).toBeGreaterThan(0)
    expect(getMcpAuthProxyPort()).toBe(port)
  })

  it('returns existing port on duplicate start', async () => {
    const port1 = await startMcpAuthProxy(mockAuth as never)
    const port2 = await startMcpAuthProxy(mockAuth as never)
    expect(port1).toBe(port2)
  })

  // The link id is an UNGUESSABLE 32-hex string, not a monotonic counter.
  // Each agent/session gets its own link to the one proxy; a guessable /1, /2
  // would let one session reach another's target (and its credential).
  const idOf = (proxyUrl: string): string => new URL(proxyUrl).pathname.split('/')[1]

  it('registers a target and returns a proxy URL with an unguessable id', async () => {
    const port = await startMcpAuthProxy(mockAuth as never)
    const proxyUrl = registerMcpProxyTarget(`http://127.0.0.1:${upstream.port}`, `http://127.0.0.1:${upstream.port}`)
    expect(proxyUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/[0-9a-f]{32}$`))
  })

  it('registers a target with a label', async () => {
    const port = await startMcpAuthProxy(mockAuth as never)
    const proxyUrl = registerMcpProxyTarget(`http://127.0.0.1:${upstream.port}`, `http://127.0.0.1:${upstream.port}`, 'My Integration')
    expect(proxyUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/[0-9a-f]{32}$`))
  })

  it('deduplicates repeated registrations for the same registration key', async () => {
    await startMcpAuthProxy(mockAuth as never)
    const targetUrl = `http://127.0.0.1:${upstream.port}`
    const key = 'mcp-server-row-abc'

    const url1 = registerMcpProxyTarget(key, targetUrl)
    const url2 = registerMcpProxyTarget(key, targetUrl)
    const url3 = registerMcpProxyTarget(key, targetUrl)

    // All calls should return the same proxy URL (same ID)
    expect(url2).toBe(url1)
    expect(url3).toBe(url1)

    // A different registration key gets a DIFFERENT, independent id — even
    // for a different target URL.
    const url4 = registerMcpProxyTarget('mcp-server-row-xyz', 'http://example.com:9999')
    expect(idOf(url4!)).not.toBe(idOf(url1!))
    expect(idOf(url4!)).toMatch(/^[0-9a-f]{32}$/)
  })

  // The actual bug this is a regression test for: two MCP server CONFIG ROWS
  // (e.g. the same shared endpoint added under two different accounts) that
  // happen to point at the SAME target URL must never collapse into one
  // registration — that would silently hand one account's requests the
  // other's token (whichever registered last), a cross-account access bug.
  it('keeps two different registration keys fully separate even when they share a target URL — including their tokens', async () => {
    await startMcpAuthProxy(mockAuth as never)
    const sharedUrl = `http://127.0.0.1:${upstream.port}`

    const proxyUrlA = registerMcpProxyTarget('server-row-A', sharedUrl, 'Account A', async () => 'token-for-account-A')!
    const proxyUrlB = registerMcpProxyTarget('server-row-B', sharedUrl, 'Account B', async () => 'token-for-account-B')!

    expect(idOf(proxyUrlA)).not.toBe(idOf(proxyUrlB))

    await fetch(proxyUrlA, { method: 'POST', body: '{}' })
    expect(upstream.lastHeaders()['authorization']).toBe('Bearer token-for-account-A')

    await fetch(proxyUrlB, { method: 'POST', body: '{}' })
    expect(upstream.lastHeaders()['authorization']).toBe('Bearer token-for-account-B')

    // Registering B did NOT retroactively change A's token.
    await fetch(proxyUrlA, { method: 'POST', body: '{}' })
    expect(upstream.lastHeaders()['authorization']).toBe('Bearer token-for-account-A')
  })

  it('returns null from registerMcpProxyTarget when proxy is not running', () => {
    const result = registerMcpProxyTarget('some-key', 'http://example.com')
    expect(result).toBeNull()
  })

  // Major finding 3: a plain remote MCP server with a user-typed static
  // header (no OAuth/enterprise token refresh at all) must still be routed
  // through the proxy — the header value itself must never appear in the
  // mcpServers config object handed to a harness.
  it('forwards a static header (e.g. a user-typed API key) with no token provider at all', async () => {
    await startMcpAuthProxy()
    const proxyUrl = registerMcpProxyTarget(
      'static-header-server',
      `http://127.0.0.1:${upstream.port}`,
      'Static Header Server',
      undefined,
      { 'X-API-Key': 'sk-static-plain-key' }
    )!

    await fetch(proxyUrl, { method: 'POST', body: '{}' })
    expect(upstream.lastHeaders()['x-api-key']).toBe('sk-static-plain-key')
    // No dynamic Authorization was registered — none should be injected.
    expect(upstream.lastHeaders()['authorization']).toBeUndefined()
  })

  it('forwards multiple static headers unchanged', async () => {
    await startMcpAuthProxy()
    const proxyUrl = registerMcpProxyTarget(
      'multi-header-server',
      `http://127.0.0.1:${upstream.port}`,
      undefined,
      undefined,
      { 'X-API-Key': 'key-1', 'X-Tenant-Id': 'tenant-42' }
    )!

    await fetch(proxyUrl, { method: 'POST', body: '{}' })
    expect(upstream.lastHeaders()['x-api-key']).toBe('key-1')
    expect(upstream.lastHeaders()['x-tenant-id']).toBe('tenant-42')
  })

  it('a dynamic token provider overwrites a stale static Authorization header, not the other way around', async () => {
    await startMcpAuthProxy()
    const proxyUrl = registerMcpProxyTarget(
      'static-plus-dynamic',
      `http://127.0.0.1:${upstream.port}`,
      'Mixed',
      async () => 'fresh-dynamic-token',
      { Authorization: 'Bearer stale-static-value', 'X-Other': 'kept' }
    )!

    await fetch(proxyUrl, { method: 'POST', body: '{}' })
    expect(upstream.lastHeaders()['authorization']).toBe('Bearer fresh-dynamic-token')
    // The unrelated static header survives even though Authorization was overwritten.
    expect(upstream.lastHeaders()['x-other']).toBe('kept')
  })

  it('re-registering the same key with an empty headers object clears a previously-set static header', async () => {
    await startMcpAuthProxy()
    const targetUrl = `http://127.0.0.1:${upstream.port}`
    const firstUrl = registerMcpProxyTarget('rotating-header-server', targetUrl, undefined, undefined, {
      'X-API-Key': 'old-key'
    })!
    await fetch(firstUrl, { method: 'POST', body: '{}' })
    expect(upstream.lastHeaders()['x-api-key']).toBe('old-key')

    const secondUrl = registerMcpProxyTarget('rotating-header-server', targetUrl, undefined, undefined, {})!
    expect(secondUrl).toBe(firstUrl)
    await fetch(secondUrl, { method: 'POST', body: '{}' })
    expect(upstream.lastHeaders()['x-api-key']).toBeUndefined()
  })

  it('503s when a registration has neither a token provider nor any static header', async () => {
    await startMcpAuthProxy()
    const proxyUrl = registerMcpProxyTarget('no-auth-at-all', `http://127.0.0.1:${upstream.port}`)!

    const response = await fetch(proxyUrl, { method: 'POST', body: '{}' })
    expect(response.status).toBe(503)
  })

  it('unregistering a target clears its static headers too', async () => {
    await startMcpAuthProxy()
    const targetUrl = `http://127.0.0.1:${upstream.port}`
    const proxyUrl = registerMcpProxyTarget('unregister-headers', targetUrl, undefined, undefined, {
      'X-API-Key': 'to-be-cleared'
    })!
    unregisterMcpProxyTarget(proxyUrl)

    // Target no longer exists at all → 404, not a 503/leaked-header response.
    const response = await fetch(proxyUrl, { method: 'POST', body: '{}' })
    expect(response.status).toBe(404)
  })

  it('forwards POST requests with fresh JWT to upstream', async () => {
    await startMcpAuthProxy(mockAuth as never)
    const proxyUrl = registerMcpProxyTarget(`http://127.0.0.1:${upstream.port}`, `http://127.0.0.1:${upstream.port}`)!

    const body = JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 })
    const response = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    })

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data).toEqual({ result: 'ok', method: 'POST' })

    // Verify JWT was injected
    expect(upstream.lastHeaders()['authorization']).toBe('Bearer jwt-token-1')
    // Verify body was forwarded
    expect(upstream.lastBody()).toBe(body)
  })

  it('injects a FRESH JWT on each request (not cached)', async () => {
    await startMcpAuthProxy(mockAuth as never)
    const proxyUrl = registerMcpProxyTarget(`http://127.0.0.1:${upstream.port}`, `http://127.0.0.1:${upstream.port}`)!

    // First request with jwt-token-1
    await fetch(proxyUrl, { method: 'POST', body: '{}' })
    expect(upstream.lastHeaders()['authorization']).toBe('Bearer jwt-token-1')

    // Change JWT (simulates token refresh)
    mockAuth.setJwt('jwt-token-REFRESHED')

    // Second request should use the new JWT
    await fetch(proxyUrl, { method: 'POST', body: '{}' })
    expect(upstream.lastHeaders()['authorization']).toBe('Bearer jwt-token-REFRESHED')

    // getJwt was called twice (once per request)
    expect(mockAuth.getCallCount()).toBe(2)
  })

  it('preserves sub-paths from the request', async () => {
    await startMcpAuthProxy(mockAuth as never)
    const proxyUrl = registerMcpProxyTarget(`http://127.0.0.1:${upstream.port}`, `http://127.0.0.1:${upstream.port}`)!

    await fetch(`${proxyUrl}/sse`, { method: 'GET' })
    expect(upstream.lastUrl()).toBe('/sse')
    expect(upstream.lastMethod()).toBe('GET')
  })

  it('returns a TERMINAL, VALID-JSON 404 for unknown target IDs (never the bare text that broke OAuth parsing)', async () => {
    await startMcpAuthProxy(mockAuth as never)

    const port = getMcpAuthProxyPort()!
    const response = await fetch(`http://127.0.0.1:${port}/deadbeef`, { method: 'POST', body: '{}' })
    const raw = await response.text()

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(raw).not.toBe('Unknown proxy target')
    const parsed = JSON.parse(raw) as { reason?: string; terminal?: boolean; retryable?: boolean }
    expect(parsed.reason).toBe('unknown_proxy_target')
    expect(parsed.terminal).toBe(true)
    expect(parsed.retryable).toBe(false)
  })

  it('returns 502 when auth fails and includes integration name in error', async () => {
    await startMcpAuthProxy(mockAuth as never)
    const proxyUrl = registerMcpProxyTarget(`http://127.0.0.1:${upstream.port}`, `http://127.0.0.1:${upstream.port}`, '[Workflo] Organisation Workspace')!

    mockAuth.setFail(true)

    const response = await fetch(proxyUrl, { method: 'POST', body: '{}' })
    expect(response.status).toBe(502)
    const data = await response.json()
    expect(data.error).toContain('Failed to obtain auth token')
    expect(data.error).toContain('[Workflo] Organisation Workspace')
  })

  it('returns 502 with fallback label when no label was set', async () => {
    await startMcpAuthProxy(mockAuth as never)
    const proxyUrl = registerMcpProxyTarget(`http://127.0.0.1:${upstream.port}`, `http://127.0.0.1:${upstream.port}`)!

    mockAuth.setFail(true)

    const response = await fetch(proxyUrl, { method: 'POST', body: '{}' })
    expect(response.status).toBe(502)
    const data = await response.json()
    // The fallback label is `target <id>`, and the id is the unguessable
    // hex from the link itself — not a monotonic counter.
    expect(data.error).toContain(`target ${idOf(proxyUrl)}`)
  })

  it('shows a notification on first JWT failure per integration', async () => {
    await startMcpAuthProxy(mockAuth as never)
    const proxyUrl = registerMcpProxyTarget(`http://127.0.0.1:${upstream.port}`, `http://127.0.0.1:${upstream.port}`, 'HubSpot')!

    mockAuth.setFail(true)

    await fetch(proxyUrl, { method: 'POST', body: '{}' })

    expect(mockNotificationConstructor).toHaveBeenCalledTimes(1)
    expect(mockNotificationConstructor).toHaveBeenCalledWith({
      title: 'MCP Auth Failed',
      body: 'Could not authenticate "HubSpot" — please sign in again.'
    })
    expect(mockNotificationShow).toHaveBeenCalledTimes(1)
  })

  it('deduplicates notifications — only one per integration per app run', async () => {
    await startMcpAuthProxy(mockAuth as never)
    const proxyUrl = registerMcpProxyTarget(`http://127.0.0.1:${upstream.port}`, `http://127.0.0.1:${upstream.port}`, 'Linear')!

    mockAuth.setFail(true)

    // Fire 3 requests — all fail
    await fetch(proxyUrl, { method: 'POST', body: '{}' })
    await fetch(proxyUrl, { method: 'POST', body: '{}' })
    await fetch(proxyUrl, { method: 'POST', body: '{}' })

    // Notification should only fire once for "Linear"
    expect(mockNotificationConstructor).toHaveBeenCalledTimes(1)
    expect(mockNotificationShow).toHaveBeenCalledTimes(1)
  })

  it('shows separate notifications for different integrations', async () => {
    await startMcpAuthProxy(mockAuth as never)

    // Create a second upstream to get a different target URL
    const upstream2 = await createMockUpstream()

    const proxyUrl1 = registerMcpProxyTarget(`http://127.0.0.1:${upstream.port}`, `http://127.0.0.1:${upstream.port}`, 'Integration A')!
    const proxyUrl2 = registerMcpProxyTarget(`http://127.0.0.1:${upstream2.port}`, `http://127.0.0.1:${upstream2.port}`, 'Integration B')!

    mockAuth.setFail(true)

    await fetch(proxyUrl1, { method: 'POST', body: '{}' })
    await fetch(proxyUrl2, { method: 'POST', body: '{}' })

    // Two different integrations → two notifications
    expect(mockNotificationConstructor).toHaveBeenCalledTimes(2)
    expect(mockNotificationShow).toHaveBeenCalledTimes(2)

    const calls = mockNotificationConstructor.mock.calls
    expect(calls[0][0].body).toContain('Integration A')
    expect(calls[1][0].body).toContain('Integration B')

    await new Promise<void>((resolve) => upstream2.server.close(() => resolve()))
  })

  it('resets notification dedup state on stop/restart', async () => {
    await startMcpAuthProxy(mockAuth as never)
    const proxyUrl = registerMcpProxyTarget(`http://127.0.0.1:${upstream.port}`, `http://127.0.0.1:${upstream.port}`, 'Notion')!

    mockAuth.setFail(true)
    await fetch(proxyUrl, { method: 'POST', body: '{}' })
    expect(mockNotificationShow).toHaveBeenCalledTimes(1)

    // Stop clears dedup state
    stopMcpAuthProxy()
    mockNotificationShow.mockClear()
    mockNotificationConstructor.mockClear()

    // Restart and re-register
    await startMcpAuthProxy(mockAuth as never)
    const proxyUrl2 = registerMcpProxyTarget(`http://127.0.0.1:${upstream.port}`, `http://127.0.0.1:${upstream.port}`, 'Notion')!

    await fetch(proxyUrl2, { method: 'POST', body: '{}' })

    // Should notify again after restart (new "app run")
    expect(mockNotificationShow).toHaveBeenCalledTimes(1)
  })

  it('unregisters targets correctly', async () => {
    await startMcpAuthProxy(mockAuth as never)
    const proxyUrl = registerMcpProxyTarget(`http://127.0.0.1:${upstream.port}`, `http://127.0.0.1:${upstream.port}`)!

    // Works before unregister
    const before = await fetch(proxyUrl, { method: 'POST', body: '{}' })
    expect(before.status).toBe(200)

    // Unregister
    unregisterMcpProxyTarget(proxyUrl)

    // 404 after unregister
    const after = await fetch(proxyUrl, { method: 'POST', body: '{}' })
    expect(after.status).toBe(404)
  })

  it('cleans up on stop', async () => {
    await startMcpAuthProxy(mockAuth as never)
    expect(getMcpAuthProxyPort()).not.toBeNull()

    stopMcpAuthProxy()
    expect(getMcpAuthProxyPort()).toBeNull()
  })

  it('handles multiple concurrent requests with fresh JWT each', async () => {
    let callNum = 0
    // Override getJwt to return sequential tokens
    mockAuth.getJwt = async () => `jwt-call-${++callNum}`

    await startMcpAuthProxy(mockAuth as never)
    const proxyUrl = registerMcpProxyTarget(`http://127.0.0.1:${upstream.port}`, `http://127.0.0.1:${upstream.port}`)!

    // Fire 5 concurrent requests
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch(proxyUrl, { method: 'POST', body: '{}' })
      )
    )

    // All should succeed
    for (const r of responses) {
      expect(r.status).toBe(200)
    }

    // getJwt should have been called 5 times (once per request)
    expect(callNum).toBe(5)
  })

  it('forwards query parameters to upstream', async () => {
    await startMcpAuthProxy(mockAuth as never)
    const proxyUrl = registerMcpProxyTarget(`http://127.0.0.1:${upstream.port}`, `http://127.0.0.1:${upstream.port}`)!

    await fetch(`${proxyUrl}?foo=bar&baz=1`, { method: 'GET' })
    expect(upstream.lastUrl()).toBe('/?foo=bar&baz=1')
  })
})
