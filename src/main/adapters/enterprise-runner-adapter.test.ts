import { describe, expect, it, vi } from 'vitest'
import { MessagePartType, SessionStatusType, type SessionConfig } from './coding-agent-adapter'
import { EnterpriseRunnerAdapter, MCP_NOTE_TEXT, type EnterpriseRunnerHost } from './enterprise-runner-adapter'
import {
  RunnerHttpError,
  type RunnerApi,
  type StartSessionInput,
  type StreamEvent,
  type WirePart,
  type WireSession,
  type WireTranscriptPage
} from '../enterprise-runner/runner-api'
import { APPROVAL_TTL_MS } from '../../shared/enterprise-runners'

// ── fakes ────────────────────────────────────────────────────────────

type Connection = Array<StreamEvent | Error>

class FakeApi implements RunnerApi {
  calls: Array<{ name: string; args: unknown[] }> = []
  connections: Connection[] = []
  streamStarts: number[] = []
  session: WireSession = { id: 'sess-1', status: 'running', runnerId: 'r1', humanTaskId: 't-server' }
  startFailures = 0
  transcriptPage: WireTranscriptPage = { parts: [], maxRev: 0 }
  deltaPage: WireTranscriptPage = { parts: [], maxRev: 0 }
  private log(name: string, ...args: unknown[]): void { this.calls.push({ name, args }) }
  called(name: string): unknown[][] { return this.calls.filter((c) => c.name === name).map((c) => c.args) }

  async listRunners() { this.log('listRunners'); return [] }
  async listAgents() { return [] }
  async startTaskSession(taskId: string, input: StartSessionInput, cb?: (s: WireSession, attached: boolean) => void) {
    this.log('startTaskSession', taskId, input)
    if (this.startFailures > 0) { this.startFailures--; throw new RunnerHttpError('network down', null, 'network') }
    cb?.(this.session, true)
    return { session: this.session }
  }
  async getSession() { return this.session }
  async attachTask(sessionId: string, taskId: string) { this.log('attachTask', sessionId, taskId) }
  async sendMessage(sessionId: string, input: { content: string; clientMessageId: string }) { this.log('sendMessage', sessionId, input) }
  async answer(sessionId: string, input: unknown) { this.log('answer', sessionId, input) }
  async abort(sessionId: string) { this.log('abort', sessionId) }
  async end(sessionId: string) { this.log('end', sessionId) }
  async transcript(sessionId: string) { this.log('transcript', sessionId); return this.transcriptPage }
  async delta(sessionId: string, sinceRev: number) { this.log('delta', sessionId, sinceRev); return this.deltaPage }
  async listArtifacts() { return [] }
  setKnownSecrets(values: Iterable<string>) { this.log('setKnownSecrets', [...values]) }
  async *stream(_id: string, sinceRev: number, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    this.streamStarts.push(sinceRev)
    const conn = this.connections.shift()
    if (!conn) {
      // Nothing scripted: a healthy idle connection (the server sends a
      // heartbeat), held open until aborted.
      yield { type: 'heartbeat', id: null }
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
      return
    }
    for (const item of conn) {
      if (item instanceof Error) throw item
      yield item
    }
  }
}

function part(partId: string, over: Partial<WirePart> = {}): WirePart {
  return {
    partId, seq: 1, role: 'assistant', content: 'hi', partType: 'text', tool: null, payload: null,
    createdAt: new Date(1_000_000).toISOString(), rev: 1, userId: null, ...over
  }
}

function partsEvent(parts: WirePart[], maxRev: number, session?: WireSession): StreamEvent {
  return { type: 'parts', id: maxRev, page: { parts, maxRev, session } }
}

function makeHost(api: FakeApi, over: Partial<EnterpriseRunnerHost> = {}) {
  const data = new Map<string, string>()
  const snapshots: unknown[] = []
  let now = 2_000_000
  const host: EnterpriseRunnerHost = {
    api,
    store: { get: (k) => data.get(k), set: (k, v) => void data.set(k, v), delete: (k) => void data.delete(k) },
    ensureServerTask: vi.fn(async () => 't-server'),
    getEnterpriseAgentId: () => 'agent-server-1',
    getRunnerId: () => 'r1',
    getTaskInfo: () => ({ title: 'Fix flaky test', repositories: ['acme/api'] }),
    currentUserId: () => 'me',
    onSnapshot: (s) => void snapshots.push(s),
    sleep: async () => { await Promise.resolve() },
    now: () => now,
    reconnectBaseMs: 1,
    ...over
  }
  return { host, data, snapshots, advance: (ms: number) => { now += ms } }
}

const config: SessionConfig = { agentId: 'a1', taskId: 'task-1', workspaceDir: '/tmp/ws' }

async function flush(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}

async function started(api: FakeApi, opts: Partial<EnterpriseRunnerHost> = {}) {
  const ctx = makeHost(api, opts)
  const adapter = new EnterpriseRunnerAdapter(ctx.host)
  const local = await adapter.createSession(config)
  await adapter.sendPrompt(local, [{ type: MessagePartType.TEXT, text: 'Work on it' }], config)
  await flush()
  return { adapter, ...ctx, local }
}

// ── tests ────────────────────────────────────────────────────────────

describe('EnterpriseRunnerAdapter: parts mapping and upsert by partId', () => {
  it('maps tool, question and todo payloads and upserts a changed part as an update', async () => {
    const api = new FakeApi()
    api.connections = [[
      partsEvent([
        part('p1', { content: 'Hel', rev: 1 }),
        part('p2', { partType: 'tool', tool: 'Bash', content: '', seq: 2, rev: 2, payload: { tool: { status: 'running', input: 'ls' } } })
      ], 2),
      partsEvent([part('p1', { content: 'Hello', rev: 3 })], 3),
      partsEvent([part('p1', { content: 'Hello', rev: 3 })], 3) // replay: must be a no-op
    ]]
    const { adapter, local } = await started(api)
    const out = await adapter.pollMessages(local)
    const p1 = out.filter((p) => p.id === 'p1')
    expect(p1).toHaveLength(2)
    expect(p1[0]).toMatchObject({ text: 'Hel', type: MessagePartType.TEXT })
    expect(p1[0].update).toBeUndefined()
    expect(p1[1]).toMatchObject({ text: 'Hello', update: true })
    const tool = out.find((p) => p.id === 'p2')!
    expect(tool.type).toBe(MessagePartType.TOOL)
    expect(tool.tool).toMatchObject({ name: 'Bash', status: 'running', input: 'ls' })
    expect(out.filter((p) => !p.realSessionId)).toHaveLength(3) // the replay added nothing
  })

  it('treats a lower rev as a stale copy and ignores it', async () => {
    const api = new FakeApi()
    api.connections = [[
      partsEvent([part('p1', { content: 'new', rev: 5 })], 5),
      partsEvent([part('p1', { content: 'old', rev: 2 })], 5)
    ]]
    const { adapter, local } = await started(api)
    const out = await adapter.pollMessages(local)
    expect(out.filter((p) => !p.realSessionId).map((p) => p.text)).toEqual(['new'])
  })

  it('does not collapse two identical messages from different participants', async () => {
    const api = new FakeApi()
    api.connections = [[
      partsEvent([
        part('u1', { role: 'user', content: 'run it again', userId: 'priya', seq: 1, rev: 1 }),
        part('u2', { role: 'user', content: 'run it again', userId: 'sam', seq: 2, rev: 2 })
      ], 2)
    ]]
    const { adapter, local } = await started(api)
    const out = await adapter.pollMessages(local)
    expect(out.filter((p) => p.role === 'user').map((p) => p.id)).toEqual(['u1', 'u2'])
  })
})

describe('EnterpriseRunnerAdapter: concurrent messages', () => {
  it('sends both messages with distinct clientMessageIds and never dedupes by content', async () => {
    const api = new FakeApi()
    const { adapter, local } = await started(api)
    await adapter.sendPrompt(local, [{ type: MessagePartType.TEXT, text: 'same text' }], config)
    await adapter.sendPrompt(local, [{ type: MessagePartType.TEXT, text: 'same text' }], config)
    const sent = api.called('sendMessage').map((a) => a[1] as { content: string; clientMessageId: string })
    expect(sent).toHaveLength(2)
    expect(sent[0].content).toBe(sent[1].content)
    expect(sent[0].clientMessageId).not.toBe(sent[1].clientMessageId)
  })

  it('hides the echo of its own message but shows the same text typed on the web', async () => {
    const api = new FakeApi()
    api.connections = [[new RunnerHttpError('fetch failed', null, 'network')]]
    const gate = new Promise<void>(() => undefined) // stay offline: parts arrive via the delta fallback
    const { adapter, local } = await started(api, { sleep: () => gate })
    await adapter.sendPrompt(local, [{ type: MessagePartType.TEXT, text: 'ship it' }], config)
    const sentIds = api.called('sendMessage').map((a) => (a[1] as { clientMessageId: string }).clientMessageId)
    api.deltaPage = {
      maxRev: 6,
      parts: [
        part('e1', { role: 'user', content: 'ship it', userId: 'me', seq: 5, rev: 5, payload: { clientMessageId: sentIds[0] } }),
        part('w1', { role: 'user', content: 'ship it', userId: 'priya', seq: 6, rev: 6 })
      ]
    }
    const out = (await adapter.pollMessages(local)).filter((p) => p.role === 'user')
    expect(out.map((p) => p.id)).toEqual(['w1'])
  })
})

describe('EnterpriseRunnerAdapter: SSE resume from rev', () => {
  it('reconnects from the last rev and persists it for a restart', async () => {
    const api = new FakeApi()
    api.connections = [
      [partsEvent([part('p1', { rev: 7 })], 7)],
      [partsEvent([part('p2', { rev: 9, seq: 2 })], 9)]
    ]
    const { adapter, local, data, host } = await started(api)
    await flush()
    expect(api.streamStarts.slice(0, 2)).toEqual([0, 7])
    expect(data.get('enterprise-runner:rev:sess-1')).toBe('9')
    expect((await adapter.pollMessages(local)).map((p) => p.id)).toEqual(['er-session-sess-1', 'p1', 'p2'])

    // App restart: a new adapter with the same store resumes from the saved rev.
    const api2 = new FakeApi()
    api2.transcriptPage = { parts: [part('p1', { rev: 7 }), part('p2', { rev: 9, seq: 2 })], maxRev: 9 }
    const restarted = new EnterpriseRunnerAdapter({ ...host, api: api2 })
    const messages = await restarted.resumeSession('sess-1', config)
    await flush()
    expect(messages.map((m) => m.id)).toEqual(['p1', 'p2'])
    expect(api2.streamStarts[0]).toBe(9)
  })
})

describe('EnterpriseRunnerAdapter: idempotent create', () => {
  it('returns the same session for repeated createSession calls and a restart', async () => {
    const api = new FakeApi()
    const { host, adapter, local } = await started(api)
    expect(await adapter.createSession(config)).toBe(local)
    expect(api.called('startTaskSession')).toHaveLength(1)

    const restarted = new EnterpriseRunnerAdapter(host)
    expect(await restarted.createSession(config)).toBe('sess-1')
    expect(api.called('startTaskSession')).toHaveLength(1)
  })

  it('retries a failed start with the same clientRequestId', async () => {
    const api = new FakeApi()
    api.startFailures = 1
    const ctx = makeHost(api)
    const adapter = new EnterpriseRunnerAdapter(ctx.host)
    const local = await adapter.createSession(config)
    await expect(adapter.sendPrompt(local, [{ type: MessagePartType.TEXT, text: 'go' }], config)).rejects.toThrow()
    await adapter.sendPrompt(local, [{ type: MessagePartType.TEXT, text: 'go' }], config)
    const inputs = api.called('startTaskSession').map((a) => a[1] as StartSessionInput)
    expect(inputs).toHaveLength(2)
    expect(inputs[0].clientRequestId).toBe(inputs[1].clientRequestId)
    // The server session is created once and its id is reported to agent-manager.
    const out = await adapter.pollMessages(local)
    expect(out.find((p) => p.realSessionId)?.realSessionId).toBe('sess-1')
  })

  it('syncs the 20x task to Spaces before starting and passes only allow-listed fields', async () => {
    const api = new FakeApi()
    const ctx = makeHost(api)
    const adapter = new EnterpriseRunnerAdapter(ctx.host)
    const local = await adapter.createSession(config)
    await adapter.sendPrompt(local, [{ type: MessagePartType.TEXT, text: 'go' }], config)
    expect(ctx.host.ensureServerTask).toHaveBeenCalledWith('task-1')
    const [taskId, input] = api.called('startTaskSession')[0] as [string, StartSessionInput]
    expect(taskId).toBe('t-server')
    expect(Object.keys(input).sort()).toEqual(['agentId', 'clientRequestId', 'message', 'repositories', 'runnerId', 'title'])
    expect(input).toMatchObject({ agentId: 'agent-server-1', runnerId: 'r1', repositories: ['acme/api'] })
  })
})

describe('EnterpriseRunnerAdapter: approvals', () => {
  const approvalPart = (over: Partial<WirePart> = {}): WirePart => part('perm-1', {
    partType: 'question', tool: 'permission', content: 'git push origin fix/x', seq: 3, rev: 3,
    payload: { questions: [{ header: 'Permission', question: 'git push origin fix/x', options: [
      { id: 'approved', label: 'Allow' }, { id: 'approved-for-session', label: 'Always allow' }, { id: 'abort', label: 'Reject' }
    ] }] },
    createdAt: new Date(2_000_000).toISOString(), ...over
  })

  it('offers Allow / Reject only, answers with the server option id, and marks the card answered', async () => {
    const api = new FakeApi()
    api.connections = [[partsEvent([approvalPart()], 3)]]
    const { adapter, local } = await started(api)
    const pending = adapter.getPendingApproval(local)!
    expect(pending.options.map((o) => o.name)).toEqual(['Allow', 'Reject'])
    expect((await adapter.getStatus(local, config)).type).toBe(SessionStatusType.WAITING_APPROVAL)

    expect(await adapter.respondToApproval(local, true, undefined, 'perm-1')).toBe(true)
    expect(api.called('answer')[0]).toEqual(['sess-1', { partId: 'perm-1', answer: 'Allow', optionId: 'approved' }])
    expect(adapter.getPendingApproval(local)).toBeNull()
    const out = await adapter.pollMessages(local)
    expect(out.at(-1)).toMatchObject({ id: 'perm-1', update: true, tool: { status: 'completed', output: 'Approved' } })
  })

  it('rejecting sends the reject option', async () => {
    const api = new FakeApi()
    api.connections = [[partsEvent([approvalPart()], 3)]]
    const { adapter, local } = await started(api)
    await adapter.respondToApproval(local, false, undefined, 'perm-1')
    expect(api.called('answer')[0][1]).toMatchObject({ optionId: 'abort', answer: 'Reject' })
  })

  it('never selects an "always allow" option, even when asked for it', async () => {
    const api = new FakeApi()
    api.connections = [[partsEvent([approvalPart()], 3)]]
    const { adapter, local } = await started(api)
    await adapter.respondToApproval(local, true, 'approved-for-session', 'perm-1')
    expect(api.called('answer')[0][1]).toMatchObject({ optionId: 'approved' })
  })

  it('treats a request older than 30 minutes as expired and does not call the server', async () => {
    const api = new FakeApi()
    api.connections = [[partsEvent([approvalPart()], 3)]]
    const { adapter, local, advance } = await started(api)
    advance(APPROVAL_TTL_MS + 1000)
    expect(adapter.getPendingApproval(local)).toBeNull()
    expect(await adapter.respondToApproval(local, true, undefined, 'perm-1')).toBe(false)
    expect(api.called('answer')).toHaveLength(0)
    expect((await adapter.getStatus(local, config)).type).not.toBe(SessionStatusType.WAITING_APPROVAL)
  })

  it('answers a question with the matching option id', async () => {
    const api = new FakeApi()
    api.connections = [[partsEvent([part('q1', {
      partType: 'question', tool: 'AskUserQuestion', createdAt: new Date(2_000_000).toISOString(), seq: 2, rev: 2,
      payload: { questions: [{ header: 'Fix', question: 'Which?', options: [{ id: 'lock', label: 'Lock per invoice' }, { id: 'idem', label: 'Idempotent handler' }] }] }
    })], 2)]]
    const { adapter, local } = await started(api)
    await adapter.respondToQuestion(local, { Fix: 'Lock per invoice' }, config, 'q1')
    expect(api.called('answer')[0]).toEqual(['sess-1', { partId: 'q1', answer: 'Lock per invoice', optionId: 'lock' }])
  })
})

describe('EnterpriseRunnerAdapter: abort, destroy, MCP', () => {
  it('abort calls /abort; endSession calls /end and forgets the session', async () => {
    const api = new FakeApi()
    const { adapter, local, data } = await started(api)
    await adapter.abortPrompt(local, config)
    expect(api.called('abort')).toEqual([['sess-1']])
    await adapter.endSession(local, config)
    expect(api.called('end')).toEqual([['sess-1']])
    expect(data.get('enterprise-runner:session:task-1')).toBeUndefined()
    expect(data.get('enterprise-runner:rev:sess-1')).toBeUndefined()
  })

  it('destroySession only detaches: no /end, record and rev kept, and a restart resumes from the saved rev', async () => {
    const api = new FakeApi()
    api.connections = [[partsEvent([part('p1', { rev: 7 })], 7)]]
    const { adapter, local, data, host } = await started(api)
    await adapter.destroySession(local, config) // what quit and the idle release call
    expect(api.called('end')).toHaveLength(0)
    expect(JSON.parse(data.get('enterprise-runner:session:task-1')!)).toMatchObject({ remoteSessionId: 'sess-1' })
    expect(data.get('enterprise-runner:rev:sess-1')).toBe('7')
    expect(await adapter.pollMessages(local)).toEqual([])

    const api2 = new FakeApi()
    const restarted = new EnterpriseRunnerAdapter({ ...host, api: api2 })
    expect(await restarted.createSession(config)).toBe('sess-1')
    await flush()
    expect(api2.streamStarts[0]).toBe(7)
    expect(api2.called('end')).toHaveLength(0)
  })

  it('registerMcpServer is a no-op and a visible note is shown once', async () => {
    const api = new FakeApi()
    const ctx = makeHost(api)
    const adapter = new EnterpriseRunnerAdapter(ctx.host)
    await adapter.registerMcpServer()
    const cfg = { ...config, mcpServers: { 'task-management': { type: 'http' as const, url: 'http://127.0.0.1:1234' } } }
    const local = await adapter.createSession(cfg)
    await adapter.sendPrompt(local, [{ type: MessagePartType.TEXT, text: 'a' }], cfg)
    await adapter.sendPrompt(local, [{ type: MessagePartType.TEXT, text: 'b' }], cfg)
    const notes = (await adapter.pollMessages(local)).filter((p) => p.text === MCP_NOTE_TEXT)
    expect(notes).toHaveLength(1)
    expect(notes[0].role).toBe('system')
  })
})

describe('EnterpriseRunnerAdapter: offline, then back', () => {
  it('falls back to /transcript/delta while the stream is down, then resumes from the stream', async () => {
    const api = new FakeApi()
    api.connections = [[new RunnerHttpError('fetch failed', null, 'network')]]
    api.deltaPage = { parts: [part('missed', { rev: 10, seq: 10 })], maxRev: 10 }
    // Hold the reconnect back so the session stays offline until we say so.
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { adapter, local, snapshots } = await started(api, { sleep: () => gate })
    expect(adapter.getSnapshot(local)!.connected).toBe(false)

    const polled = await adapter.pollMessages(local)
    expect(polled.map((p) => p.id)).toContain('missed')
    expect(api.called('delta')[0]).toEqual(['sess-1', 0])

    api.connections.push([partsEvent([part('late', { rev: 12, seq: 12 })], 12, { ...api.session, status: 'idle' })])
    release()
    await flush()
    expect(api.streamStarts.slice(0, 2)).toEqual([0, 10]) // resumed from the delta's rev, not from zero
    expect(adapter.getSnapshot(local)).toMatchObject({ connected: true, rev: 12 })
    expect((snapshots as Array<{ connected: boolean }>).some((x) => x.connected === false)).toBe(true)
    expect((await adapter.pollMessages(local)).map((p) => p.id)).toContain('late')
    expect((await adapter.getStatus(local, config)).type).toBe(SessionStatusType.IDLE)
  })

  it('stops retrying when the server says the session is forbidden or gone', async () => {
    const api = new FakeApi()
    api.connections = [[new RunnerHttpError('gone', 404, 'not-found')]]
    const { adapter, local } = await started(api)
    await flush()
    expect(api.streamStarts).toHaveLength(1)
    expect((await adapter.getStatus(local, config)).type).toBe(SessionStatusType.ERROR)
  })
})

describe('EnterpriseRunnerAdapter: status and completion', () => {
  it('reports IDLE when the session finishes and never completes anything itself', async () => {
    const api = new FakeApi()
    api.connections = [[{ type: 'session', id: 4, session: { ...api.session, status: 'completed' } }]]
    const { adapter, local } = await started(api)
    expect((await adapter.getStatus(local, config)).type).toBe(SessionStatusType.IDLE)
    // The API surface has no completion call at all.
    expect(Object.keys(api.constructor.prototype)).not.toContain('complete')
    expect(api.calls.map((c) => c.name)).not.toContain('completeTask')
  })

  it('reports turn usage through onUsage as a discrete item', async () => {
    const api = new FakeApi()
    api.connections = [[partsEvent([part('sum1', {
      partType: 'turn_summary', content: '', payload: { usage: { inputTokens: 30000, outputTokens: 18000, costUsd: 0.61, model: 'claude-x' } }
    })], 4)]]
    const ctx = makeHost(api)
    const adapter = new EnterpriseRunnerAdapter(ctx.host)
    const reports: unknown[] = []
    adapter.onUsage = (r) => void reports.push(r)
    const local = await adapter.createSession(config)
    await adapter.sendPrompt(local, [{ type: MessagePartType.TEXT, text: 'go' }], config)
    await flush()
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ kind: 'discrete', provider: 'enterprise-runner', items: [{ sourceKey: 'sess-1:sum1', model: 'claude-x' }] })
    expect(adapter.getSnapshot(local)!.usage).toMatchObject({ tokens: 48000, costUsd: 0.61 })
  })
})

describe('EnterpriseRunnerAdapter: creation races and repair', () => {
  it('sends a message that arrives while the session is being created, instead of dropping it', async () => {
    const api = new FakeApi()
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => { release = r })
    const original = api.startTaskSession.bind(api)
    api.startTaskSession = async (t: string, i: StartSessionInput, cb?: Parameters<RunnerApi['startTaskSession']>[2]) => { await gate; return original(t, i, cb) }
    const ctx = makeHost(api)
    const adapter = new EnterpriseRunnerAdapter(ctx.host)
    const local = await adapter.createSession(config)
    const first = adapter.sendPrompt(local, [{ type: MessagePartType.TEXT, text: 'first' }], config)
    const second = adapter.sendPrompt(local, [{ type: MessagePartType.TEXT, text: 'second' }], config)
    release()
    await Promise.all([first, second])
    expect(api.called('startTaskSession')).toHaveLength(1)
    expect(api.called('sendMessage').map((a) => (a[1] as { content: string }).content)).toEqual(['second'])
  })

  it('persists the session id as soon as it is created and re-attaches an unlinked session on the next start', async () => {
    const api = new FakeApi()
    api.startTaskSession = async (_t: string, _i: StartSessionInput, cb?: Parameters<RunnerApi['startTaskSession']>[2]) => {
      cb?.(api.session, false) // session created, attach not done yet
      throw new RunnerHttpError('network down', null, 'network') // crash before attach
    }
    const ctx = makeHost(api)
    const adapter = new EnterpriseRunnerAdapter(ctx.host)
    const local = await adapter.createSession(config)
    await expect(adapter.sendPrompt(local, [{ type: MessagePartType.TEXT, text: 'go' }], config)).rejects.toThrow()
    expect(JSON.parse(ctx.data.get('enterprise-runner:session:task-1')!)).toMatchObject({ remoteSessionId: 'sess-1', attached: false })

    const api2 = new FakeApi()
    const restarted = new EnterpriseRunnerAdapter({ ...ctx.host, api: api2 })
    expect(await restarted.createSession(config)).toBe('sess-1')
    await flush()
    expect(api2.called('attachTask')).toEqual([['sess-1', 't-server']])
    expect(JSON.parse(ctx.data.get('enterprise-runner:session:task-1')!)).toMatchObject({ attached: true })
    expect(api2.called('startTaskSession')).toHaveLength(0)
  })

  it('reverts to the previous status when a follow-up send fails', async () => {
    const api = new FakeApi()
    api.session = { ...api.session, status: 'idle' }
    const { adapter, local } = await started(api)
    expect((await adapter.getStatus(local, config)).type).toBe(SessionStatusType.IDLE)
    api.sendMessage = async () => { throw new RunnerHttpError('boom', 500, 'server') }
    await expect(adapter.sendPrompt(local, [{ type: MessagePartType.TEXT, text: 'x' }], config)).rejects.toThrow()
    expect((await adapter.getStatus(local, config)).type).toBe(SessionStatusType.IDLE)
  })
})

describe('EnterpriseRunnerAdapter: echo matching', () => {
  it('hides only the echo carrying our clientMessageId, once, and shows identical text typed on the web', async () => {
    const api = new FakeApi()
    api.connections = [[new RunnerHttpError('fetch failed', null, 'network')]]
    const { adapter, local } = await started(api, { sleep: () => new Promise(() => undefined) })
    await adapter.sendPrompt(local, [{ type: MessagePartType.TEXT, text: 'same' }], config)
    const id = (api.called('sendMessage')[0][1] as { clientMessageId: string }).clientMessageId
    api.deltaPage = { maxRev: 9, parts: [
      part('own', { role: 'user', content: 'same', userId: 'me', seq: 7, rev: 7, payload: { clientMessageId: id } }),
      part('web', { role: 'user', content: 'same', userId: 'me', seq: 8, rev: 8 }), // same user, same text, from the web
      part('own2', { role: 'user', content: 'same', userId: 'me', seq: 9, rev: 9, payload: { clientMessageId: id } }) // id already consumed
    ] }
    const ids = (await adapter.pollMessages(local)).filter((p) => p.role === 'user').map((p) => p.id)
    expect(ids).toEqual(['web', 'own2'])
  })
})

describe('EnterpriseRunnerAdapter: truncated pages', () => {
  it('advances only to the highest applied rev and fetches the next delta', async () => {
    const api = new FakeApi()
    api.connections = [[{ type: 'parts', id: 100, page: { parts: [part('a', { rev: 3, seq: 1 }), part('b', { rev: 4, seq: 2 })], maxRev: 100, truncated: true } }]]
    api.delta = async (_id: string, since: number) => {
      api.calls.push({ name: 'delta', args: ['sess-1', since] })
      return since < 10 ? { parts: [part('c', { rev: 50, seq: 3 })], maxRev: 100, truncated: true } : { parts: [part('d', { rev: 100, seq: 4 })], maxRev: 100 }
    }
    const { adapter, local } = await started(api)
    const ids = (await adapter.pollMessages(local)).filter((p) => !p.realSessionId).map((p) => p.id)
    expect(ids).toEqual(['a', 'b', 'c', 'd'])
    expect(api.called('delta').map((a) => a[1])).toEqual([4, 50])
    expect(adapter.getSnapshot(local)!.rev).toBe(100)
  })
})

describe('EnterpriseRunnerAdapter: signed out or revoked', () => {
  it('stops the stream and the delta polling on an auth error, and resumes after sign-in', async () => {
    const api = new FakeApi()
    api.connections = [[new RunnerHttpError('Session expired', 401, 'auth')]]
    let signedIn = false
    const { adapter, local } = await started(api, { isSignedIn: () => signedIn })
    await flush()
    expect(api.streamStarts).toHaveLength(1) // no reconnect loop
    await adapter.pollMessages(local)
    expect(api.called('delta')).toHaveLength(0) // no 2s polling either
    signedIn = true
    await adapter.pollMessages(local)
    await flush()
    expect(api.streamStarts.length).toBeGreaterThan(1)
  })
})
