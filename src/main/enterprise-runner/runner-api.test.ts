import { describe, expect, it, vi } from 'vitest'
import { HttpRunnerApi, SseParser, parseStreamFrame, RunnerHttpError, type RunnerAuth } from './runner-api'

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

describe('HttpRunnerApi.stream: auth and resume', () => {
  it('opens each connection with a fresh JWT and Last-Event-ID = the resume rev', async () => {
    const a = auth()
    const fetchImpl = vi.fn(async () => sse('id: 5\nevent: parts\ndata: {"parts":[],"maxRev":5}\n\n')) as unknown as typeof fetch
    const api = new HttpRunnerApi(a, fetchImpl)
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
    const api = new HttpRunnerApi(a, fetchImpl)
    const events = await collect(api.stream('s1', 2, new AbortController().signal))
    expect(events).toHaveLength(1)
    expect(a.refreshToken).toHaveBeenCalledTimes(1)
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, { headers: Record<string, string> }]>
    expect(calls[1][1].headers.Authorization).toBe('Bearer jwt-2')
    expect(calls[1][1].headers['Last-Event-ID']).toBe('2')
  })

  it('classifies a refused stream so the adapter can stop or retry', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch
    const api = new HttpRunnerApi(auth(), fetchImpl)
    await expect(collect(api.stream('gone', 0, new AbortController().signal))).rejects.toMatchObject({ kind: 'not-found' })
    const offline = vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    await expect(collect(new HttpRunnerApi(auth(), offline).stream('s', 0, new AbortController().signal))).rejects.toBeInstanceOf(RunnerHttpError)
  })
})

describe('HttpRunnerApi: commands', () => {
  it('goes through the enterprise apiRequest (which refreshes on 401) with the documented routes', async () => {
    const a = auth()
    const api = new HttpRunnerApi(a)
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

  it('creates a session on the chosen runner, then links it to the Spaces task', async () => {
    const a = auth({ apiRequest: vi.fn(async (_m, path) => (path.endsWith('/sessions') ? { session: { id: 's9', status: 'queued', runnerId: 'r1' } } : {})) })
    const api = new HttpRunnerApi(a)
    await api.startTaskSession('task-srv', { agentId: 'ag', runnerId: 'r1', message: 'go', clientRequestId: 'crid', repositories: ['acme/api'] })
    const calls = (a.apiRequest as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0][1]).toBe('/api/coding-agents/sessions')
    expect(calls[0][2]).toEqual({ agentId: 'ag', runnerId: 'r1', message: 'go', repositories: ['acme/api'], clientRequestId: 'crid' })
    expect(calls[1]).toEqual(['POST', '/api/coding-agents/sessions/s9/task', { taskId: 'task-srv' }])
  })
})
