import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'http'

// Mock electron before importing the module
vi.mock('electron', () => ({
  app: { isPackaged: false }
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

  it('registers a target and returns a proxy URL', async () => {
    const port = await startMcpAuthProxy(mockAuth as never)
    const proxyUrl = registerMcpProxyTarget(`http://127.0.0.1:${upstream.port}`)
    expect(proxyUrl).toBe(`http://127.0.0.1:${port}/1`)
  })

  it('deduplicates repeated registrations for the same target URL', async () => {
    const port = await startMcpAuthProxy(mockAuth as never)
    const targetUrl = `http://127.0.0.1:${upstream.port}`

    const url1 = registerMcpProxyTarget(targetUrl)
    const url2 = registerMcpProxyTarget(targetUrl)
    const url3 = registerMcpProxyTarget(targetUrl)

    // All calls should return the same proxy URL (same ID)
    expect(url1).toBe(`http://127.0.0.1:${port}/1`)
    expect(url2).toBe(url1)
    expect(url3).toBe(url1)

    // A different target URL should get a new ID
    const url4 = registerMcpProxyTarget('http://example.com:9999')
    expect(url4).toBe(`http://127.0.0.1:${port}/2`)
  })

  it('returns null from registerMcpProxyTarget when proxy is not running', () => {
    const result = registerMcpProxyTarget('http://example.com')
    expect(result).toBeNull()
  })

  it('forwards POST requests with fresh JWT to upstream', async () => {
    await startMcpAuthProxy(mockAuth as never)
    const proxyUrl = registerMcpProxyTarget(`http://127.0.0.1:${upstream.port}`)!

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
    const proxyUrl = registerMcpProxyTarget(`http://127.0.0.1:${upstream.port}`)!

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
    const proxyUrl = registerMcpProxyTarget(`http://127.0.0.1:${upstream.port}`)!

    await fetch(`${proxyUrl}/sse`, { method: 'GET' })
    expect(upstream.lastUrl()).toBe('/sse')
    expect(upstream.lastMethod()).toBe('GET')
  })

  it('returns 404 for unknown target IDs', async () => {
    await startMcpAuthProxy(mockAuth as never)

    const port = getMcpAuthProxyPort()!
    const response = await fetch(`http://127.0.0.1:${port}/999`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(404)
  })

  it('returns 502 when auth fails', async () => {
    await startMcpAuthProxy(mockAuth as never)
    const proxyUrl = registerMcpProxyTarget(`http://127.0.0.1:${upstream.port}`)!

    mockAuth.setFail(true)

    const response = await fetch(proxyUrl, { method: 'POST', body: '{}' })
    expect(response.status).toBe(502)
    const data = await response.json()
    expect(data.error).toContain('Failed to obtain auth token')
  })

  it('unregisters targets correctly', async () => {
    await startMcpAuthProxy(mockAuth as never)
    const proxyUrl = registerMcpProxyTarget(`http://127.0.0.1:${upstream.port}`)!

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
    const proxyUrl = registerMcpProxyTarget(`http://127.0.0.1:${upstream.port}`)!

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
    const proxyUrl = registerMcpProxyTarget(`http://127.0.0.1:${upstream.port}`)!

    await fetch(`${proxyUrl}?foo=bar&baz=1`, { method: 'GET' })
    expect(upstream.lastUrl()).toBe('/?foo=bar&baz=1')
  })
})
