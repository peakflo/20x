import { describe, expect, it, vi } from 'vitest'
import { EnterpriseRunnersApi, RunnerHttpError, SseParser, parseStreamFrame, toFailure, type EnterpriseRequester as RunnerAuth } from './api-client'
import { runPreflight } from './preflight'

const ID = '3f6c2a9e-8b1d-4c7a-9e2f-5d4b1a0c7e63'

function api(handler: (method: string, path: string, body?: unknown) => unknown, signedIn = true) {
  const apiRequest = vi.fn(async (method: string, path: string, body?: unknown) => {
    const result = handler(method, path, body)
    if (result instanceof Error) throw result
    return result
  })
  return { client: new EnterpriseRunnersApi({ apiRequest, getApiUrl: () => 'https://api.peakflo.ai', isSignedIn: async () => signedIn }), apiRequest }
}
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status })

describe('EnterpriseRunnersApi', () => {
  it('creates a connection with discover:true and drops any token in the response', async () => {
    const { client, apiRequest } = api(() => ({ tokenId: ID, expiresAt: '2026-11-23T12:15:00Z', enrolmentToken: 'enrol-secret' }))
    const info = await client.createConnection(['codex'])
    expect(info).toEqual({ connectionId: ID, expiresAt: '2026-11-23T12:15:00Z' })
    expect(JSON.stringify(info)).not.toContain('enrol-secret')
    expect(apiRequest).toHaveBeenCalledWith('POST', '/api/onboarding/byo/tokens', { discover: true, allowed_vendor_backends: ['codex'] })
  })

  it('sends replaces_runner_id on reconnect', async () => {
    const { client, apiRequest } = api(() => ({ tokenId: ID }))
    await client.createConnection(['claude-code', 'codex', 'cursor'], 'r1')
    expect(apiRequest.mock.calls[0][2]).toMatchObject({ replaces_runner_id: 'r1' })
  })

  it('reads the server pin and engines, and ignores a malformed pin', async () => {
    expect(await api(() => ({ version: '1.8.2', channel: 'final', nodeEngines: '^22.23.5' })).client.getHarnessVersion()).toEqual({ version: '1.8.2', nodeEngines: '^22.23.5' })
    expect((await api(() => ({ version: 'latest' })).client.getHarnessVersion()).version).toBeNull()
  })

  it('uses the documented routes for rename, remove and update', async () => {
    const { client, apiRequest } = api(() => ({ ok: true }))
    await client.renameMachine('r1', '  Mac  ')
    await client.removeMachine('r1')
    await client.updateMachine('r1')
    expect(apiRequest.mock.calls).toEqual([
      ['PATCH', '/api/onboarding/byo/machines/r1', { name: 'Mac' }],
      ['DELETE', '/api/onboarding/byo/machines/r1', undefined],
      ['POST', '/api/onboarding/byo/machines/r1/update-now', undefined]
    ])
    expect(await client.renameMachine('r1', '   ')).toMatchObject({ ok: false })
  })

  it('merges machines + runners + pin into one snapshot', async () => {
    const { client } = api((_m, path) => {
      if (path.endsWith('/machines')) return { machines: [{ runnerId: 'm1', name: 'studio-mac', personal: true, isOwner: true, canManage: true, harnessVersion: '1.7.0', registered: true, update: { available: true, targetVersion: '1.8.2' } }] }
      if (path.endsWith('/runners')) return { runners: [{ id: 'm1', name: 'studio-mac', personal: true, canSelect: true, status: 'ready', lastHeartbeatAt: new Date().toISOString() }] }
      return { version: '1.8.2', nodeEngines: null }
    })
    const result = await client.listMachines('studio-mac')
    expect(result.ok && result.snapshot.pinnedVersion).toBe('1.8.2')
    expect(result.ok && result.snapshot.machines[0].versionState.kind).toBe('update_available')
  })

  it('degrades when one list fails, and maps 403 / signed-out / unavailable', async () => {
    const half = api((_m, path) => (path.endsWith('/runners') ? httpError(500, 'boom') : path.endsWith('/machines') ? { machines: [{ runnerId: 'm1', name: 'a', personal: true, isOwner: true, registered: true }] } : { version: null }))
    expect((await half.client.listMachines()).ok).toBe(true)

    const denied = api(() => httpError(403, 'Permission denied'))
    expect(await denied.client.listMachines()).toMatchObject({ ok: false, error: { kind: 'permission_denied' } })
    const out = api(() => ({}), false)
    expect(await out.client.listMachines()).toMatchObject({ ok: false, error: { kind: 'not_signed_in' } })
    const down = api(() => httpError(503, 'unavailable'))
    expect(await down.client.listMachines()).toMatchObject({ ok: false, error: { kind: 'unavailable' } })
    expect(toFailure(new Error('Session expired — please sign in again')).kind).toBe('not_signed_in')
  })
})

describe('runPreflight', () => {
  const ok = { getHarnessVersion: async () => ({ version: '1.8.2', nodeEngines: '^22.23.5 || ^24.22.3 || >=26.13.1 <27' }), getApiUrl: () => 'https://api.peakflo.ai' }
  const tools = { node: '/opt/node/bin/node', npx: '/opt/node/bin/npx', git: '/usr/bin/git', dirs: ['/opt/node/bin', '/usr/bin'] }
  const run = (node: string | null, git: string | null, npx: string | null = '10.9.2') => async (command: string) =>
    command.endsWith('/node')
      ? { ok: node !== null, stdout: node ?? '' }
      : command.endsWith('/npx')
        ? { ok: npx !== null, stdout: npx ?? '' }
        : { ok: git !== null, stdout: git ?? '' }
  const base = { platform: 'darwin' as const, arch: 'arm64', api: ok, isSignedIn: async () => true, toolchain: tools }

  it('passes with OS, Node in range, Git and sign-in', async () => {
    const result = await runPreflight({ ...base, run: run('v22.23.5\n', 'git version 2.45.1') })
    expect(result.ok).toBe(true)
    expect(result.checks.map((c) => [c.id, c.ok])).toEqual([['os', true], ['signed_in', true], ['node', true], ['npx', true], ['git', true]])
    expect(result).toMatchObject({ pinnedVersion: '1.8.2', controlPlane: 'https://api.peakflo.ai' })
  })

  it('fails on Node out of range, with install help', async () => {
    const result = await runPreflight({ ...base, run: run('v22.4.0', 'git version 2.45.1') })
    expect(result.ok).toBe(false)
    expect(result.failure).toMatchObject({ kind: 'node_missing', help: 'brew upgrade node' })
  })

  it('fails on Node or Git missing', async () => {
    expect((await runPreflight({ ...base, run: run(null, 'git version 2.45.1') })).failure?.kind).toBe('node_missing')
    expect((await runPreflight({ ...base, run: run('v22.23.5', null) })).failure).toMatchObject({ kind: 'git_missing', help: 'xcode-select --install' })
  })

  it('fails when Node is present but npx (npm) is not', async () => {
    const result = await runPreflight({ ...base, run: run('v22.23.5', 'git version 2.45.1', null) })
    expect(result.ok).toBe(false)
    expect(result.checks.find((c) => c.id === 'npx')).toMatchObject({ ok: false, help: 'brew reinstall node' })
    expect(result.failure).toMatchObject({ kind: 'node_missing' })
    expect(result.failure?.message).toMatch(/npx/)
    const unresolved = await runPreflight({ ...base, toolchain: { ...tools, npx: null }, run: run('v22.23.5', 'git version 2.45.1') })
    expect(unresolved.checks.find((c) => c.id === 'npx')?.ok).toBe(false)
  })

  it('runs the binaries it resolved, by absolute path', async () => {
    const seen: string[] = []
    await runPreflight({ ...base, run: async (c) => { seen.push(c); return { ok: true, stdout: 'v22.23.5 1.2.3 2.45.1' } } })
    expect(seen).toEqual(['/opt/node/bin/node', '/opt/node/bin/npx', '/usr/bin/git'])
  })

  it('fails on Windows and when signed out', async () => {
    expect((await runPreflight({ ...base, platform: 'win32', run: run('v22.23.5', 'git version 2.45.1') })).failure?.kind).toBe('unsupported_os')
    expect((await runPreflight({ ...base, isSignedIn: async () => false, run: run('v22.23.5', 'git version 2.45.1') })).failure?.kind).toBe('not_signed_in')
  })

  it('fails when the server has no published version', async () => {
    const result = await runPreflight({ ...base, api: { ...ok, getHarnessVersion: async () => ({ version: null, nodeEngines: null }) }, run: run('v22.23.5', 'git version 2.45.1') })
    expect(result.failure?.kind).toBe('version_unavailable')
  })
})

describe('computer service instance', () => {
  it('hashes the exact --control-plane origin 20x passes, with tenant and user ids', async () => {
    const { createHash } = await import('node:crypto')
    const client = new EnterpriseRunnersApi({
      apiRequest: async () => ({}),
      getApiUrl: () => 'https://api.peakflo.ai',
      isSignedIn: async () => true,
      getIdentity: async () => ({ tenantId: 'T', userId: 'U' })
    })
    const expected = 'computer-' + createHash('sha256').update('https://api.peakflo.ai:T:U').digest('hex').slice(0, 24)
    expect(await client.getComputerInstance()).toBe(expected)
  })
})

// ── Running tasks on runners: sessions, SSE, JWT refresh ──────────

function sse(...frames: string[]): Response {
  const enc = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f))
      controller.close()
    }
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

function auth(overrides: Partial<RunnerAuth> = {}): RunnerAuth & { jwt: string } {
  const a = {
    jwt: 'jwt-1',
    apiRequest: vi.fn(async () => ({})),
    getJwt: vi.fn(async () => a.jwt),
    getApiUrl: () => 'https://api.peakflo.ai',
    isSignedIn: async () => true,
    refreshToken: vi.fn(async () => { a.jwt = 'jwt-2'; return { token: 'jwt-2' } }),
    ...overrides
  }
  return a as RunnerAuth & { jwt: string }
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const e of gen) out.push(e)
  return out
}

describe('SseParser', () => {
  it('parses frames split across chunks, comments and CRLF', () => {
    const p = new SseParser()
    expect(p.push('id: 3\nevent: par')).toEqual([])
    const frames = p.push('ts\ndata: {"a":1}\n\n: keep-alive\n\nevent: session\r\ndata: {"b":2}\r\n\r\n')
    expect(frames).toEqual([
      { event: 'parts', data: '{"a":1}', id: '3' },
      { event: 'session', data: '{"b":2}', id: null }
    ])
  })

  it('maps parts and session frames and ignores malformed ones', () => {
    expect(parseStreamFrame({ event: 'parts', id: '4', data: JSON.stringify({ parts: [], maxRev: 4 }) })).toMatchObject({ type: 'parts', id: 4 })
    expect(parseStreamFrame({ event: 'session', id: null, data: JSON.stringify({ session: { id: 's', status: 'idle' } }) })).toMatchObject({ type: 'session' })
    expect(parseStreamFrame({ event: 'parts', id: null, data: '{nope' })).toBeNull()
    expect(parseStreamFrame({ event: 'heartbeat', id: null, data: '{}' })).toEqual({ type: 'heartbeat', id: null })
  })
})

describe('EnterpriseRunnersApi.stream: auth and resume', () => {
  it('opens each connection with a fresh JWT and Last-Event-ID = the resume rev', async () => {
    const a = auth()
    const fetchImpl = vi.fn(async () => sse('id: 5\nevent: parts\ndata: {"parts":[],"maxRev":5}\n\n')) as unknown as typeof fetch
    const api = new EnterpriseRunnersApi(a, fetchImpl)
    const ctrl = new AbortController()
    expect(await collect(api.stream('s1', 5, ctrl.signal))).toHaveLength(1)
    a.jwt = 'jwt-rotated' // the token changed while the first stream was open
    await collect(api.stream('s1', 5, ctrl.signal))
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, { headers: Record<string, string> }]>
    expect(calls[0][0]).toBe('https://api.peakflo.ai/api/coding-agents/sessions/s1/stream?sinceRev=5')
    expect(calls[0][1].headers['Last-Event-ID']).toBe('5')
    expect(calls[0][1].headers.Authorization).toBe('Bearer jwt-1')
    expect(calls[1][1].headers.Authorization).toBe('Bearer jwt-rotated')
  })

  it('refreshes the JWT and retries once when the stream is rejected with 401 (mid-stream expiry)', async () => {
    const a = auth()
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(sse('event: session\ndata: {"session":{"id":"s1","status":"running","runnerId":null}}\n\n')) as unknown as typeof fetch
    const api = new EnterpriseRunnersApi(a, fetchImpl)
    const events = await collect(api.stream('s1', 2, new AbortController().signal))
    expect(events).toHaveLength(1)
    expect(a.refreshToken).toHaveBeenCalledTimes(1)
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, { headers: Record<string, string> }]>
    expect(calls[1][1].headers.Authorization).toBe('Bearer jwt-2')
    expect(calls[1][1].headers['Last-Event-ID']).toBe('2')
  })

  it('classifies a refused stream so the adapter can stop or retry', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch
    const api = new EnterpriseRunnersApi(auth(), fetchImpl)
    await expect(collect(api.stream('gone', 0, new AbortController().signal))).rejects.toMatchObject({ kind: 'not-found' })
    const offline = vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    await expect(collect(new EnterpriseRunnersApi(auth(), offline).stream('s', 0, new AbortController().signal))).rejects.toBeInstanceOf(RunnerHttpError)
  })
})

describe('EnterpriseRunnersApi: commands', () => {
  it('goes through the enterprise apiRequest (which refreshes on 401) with the documented routes', async () => {
    const a = auth()
    const api = new EnterpriseRunnersApi(a)
    await api.sendMessage('s1', { content: 'hi', clientMessageId: 'c1' })
    await api.answer('s1', { partId: 'p', answer: 'Allow', optionId: 'approved' })
    await api.abort('s1')
    await api.end('s1')
    await api.delta('s1', 7)
    await api.transcript('s1')
    expect((a.apiRequest as ReturnType<typeof vi.fn>).mock.calls.map((c) => `${c[0]} ${c[1]}`)).toEqual([
      'POST /api/coding-agents/sessions/s1/messages',
      'POST /api/coding-agents/sessions/s1/answer',
      'POST /api/coding-agents/sessions/s1/abort',
      'POST /api/coding-agents/sessions/s1/end',
      'GET /api/coding-agents/sessions/s1/transcript/delta?sinceRev=7',
      'GET /api/coding-agents/sessions/s1/transcript'
    ])
  })

  it('prefers the task-linked route with runnerId and clientRequestId (idempotent)', async () => {
    const a = auth({ apiRequest: vi.fn(async (_m, path) => (path.endsWith('/session') ? { sessionId: 's9' } : { session: { id: 's9', status: 'queued', runnerId: 'r1' } })) })
    const created = vi.fn()
    await new EnterpriseRunnersApi(a).startTaskSession('task-srv', { agentId: 'ag', runnerId: 'r1', message: 'go', clientRequestId: 'crid', repositories: ['acme/api'] }, created)
    const calls = (a.apiRequest as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0]).toEqual(['POST', '/api/tasks/task-srv/session', { agentId: 'ag', runnerId: 'r1', message: 'go', repositories: ['acme/api'], clientRequestId: 'crid' }])
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ id: 's9' }), true)
  })

  it('falls back to sessions + attach on an older server, reporting the id before the attach', async () => {
    const order: string[] = []
    const a = auth({ apiRequest: vi.fn(async (_m, path) => {
      order.push(path)
      if (path === '/api/tasks/task-srv/session') throw new Error('Unrecognized key(s) in object: runnerId')
      return path.endsWith('/sessions') ? { session: { id: 's9', status: 'queued', runnerId: 'r1' } } : {}
    }) })
    const created = vi.fn(() => order.push('onCreated'))
    await new EnterpriseRunnersApi(a).startTaskSession('task-srv', { agentId: 'ag', runnerId: 'r1', message: 'go', clientRequestId: 'crid' }, created)
    expect(order).toEqual(['/api/tasks/task-srv/session', '/api/coding-agents/sessions', 'onCreated', '/api/coding-agents/sessions/s9/task'])
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ id: 's9' }), false)
  })

  it('does not fall back when the server refuses the client request id', async () => {
    const a = auth({ apiRequest: vi.fn(async () => { throw new Error('CLIENT_REQUEST_ID_REUSED (409)') }) })
    await expect(new EnterpriseRunnersApi(a).startTaskSession('t', { agentId: 'ag', message: 'go', clientRequestId: 'c' })).rejects.toThrow(/REUSED/)
    expect((a.apiRequest as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })
})
