/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mock @cursor/sdk (dynamically imported by the adapter) ──────────────────

const sdkMocks = vi.hoisted(() => {
  class CursorSdkError extends Error {}
  class AgentBusyError extends CursorSdkError {}
  class AgentNotFoundError extends CursorSdkError {}
  class UnknownAgentError extends CursorSdkError {}
  class AuthenticationError extends CursorSdkError {}
  class RateLimitError extends CursorSdkError {}
  class NetworkError extends CursorSdkError {}
  class ConfigurationError extends CursorSdkError {}

  class InMemoryCredentialStore {
    private creds: unknown
    async load(): Promise<unknown> { return this.creds }
    async save(c: unknown): Promise<void> { this.creds = c }
    async clear(): Promise<void> { this.creds = undefined }
  }

  return {
    AgentCreateMock: vi.fn(),
    AgentResumeMock: vi.fn(),
    AgentListRunsMock: vi.fn(async (): Promise<{ items: any[] }> => ({ items: [] })),
    AgentCancelRunMock: vi.fn(async () => undefined),
    AgentMessagesListMock: vi.fn(async (): Promise<any[]> => []),
    CursorModelsListMock: vi.fn(async (): Promise<any[]> => []),
    CursorMeMock: vi.fn(),
    CursorAuthLoginMock: vi.fn(),
    CursorAuthLogoutMock: vi.fn(),
    CursorSdkError,
    AgentBusyError,
    AgentNotFoundError,
    UnknownAgentError,
    AuthenticationError,
    RateLimitError,
    NetworkError,
    ConfigurationError,
    InMemoryCredentialStore
  }
})

vi.mock('@cursor/sdk', () => ({
  Agent: {
    create: sdkMocks.AgentCreateMock,
    resume: sdkMocks.AgentResumeMock,
    listRuns: sdkMocks.AgentListRunsMock,
    cancelRun: sdkMocks.AgentCancelRunMock,
    messages: { list: sdkMocks.AgentMessagesListMock }
  },
  Cursor: {
    models: { list: sdkMocks.CursorModelsListMock },
    me: sdkMocks.CursorMeMock,
    auth: { login: sdkMocks.CursorAuthLoginMock, logout: sdkMocks.CursorAuthLogoutMock, status: vi.fn() }
  },
  CursorSdkError: sdkMocks.CursorSdkError,
  AgentBusyError: sdkMocks.AgentBusyError,
  AgentNotFoundError: sdkMocks.AgentNotFoundError,
  UnknownAgentError: sdkMocks.UnknownAgentError,
  AuthenticationError: sdkMocks.AuthenticationError,
  RateLimitError: sdkMocks.RateLimitError,
  NetworkError: sdkMocks.NetworkError,
  ConfigurationError: sdkMocks.ConfigurationError,
  InMemoryCredentialStore: sdkMocks.InMemoryCredentialStore
}))

import { CursorSdkAdapter } from './cursor-sdk-adapter'
import { resolveCursorApiKey, DbSdkCredentialStore, hasExplicitApiKey } from './cursor-sdk-auth'
import { MessagePartType, MessageRole, SessionStatusType, type SessionConfig } from './coding-agent-adapter'

function makeMockDb() {
  const store = new Map<string, string>()
  return {
    getSetting: vi.fn((key: string) => store.get(key)),
    setSetting: vi.fn((key: string, value: string) => { store.set(key, value) }),
    deleteSetting: vi.fn((key: string) => { store.delete(key) })
  }
}

function makeFakeAgent(agentId: string, overrides: Partial<Record<string, any>> = {}) {
  return {
    agentId,
    model: undefined,
    send: vi.fn(),
    close: vi.fn(),
    reload: vi.fn(async () => undefined),
    listArtifacts: vi.fn(async () => []),
    downloadArtifact: vi.fn(async () => Buffer.from('')),
    getUsage: vi.fn(async () => ({ usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }, runs: [] })),
    ...overrides
  }
}

function makeFakeRun(id: string, overrides: Partial<Record<string, any>> = {}) {
  return {
    id,
    agentId: 'agent-1',
    status: 'running',
    stream: vi.fn(),
    conversation: vi.fn(async () => []),
    wait: vi.fn(async () => ({ id, status: 'finished', result: 'done' })),
    cancel: vi.fn(async () => undefined),
    onDidChangeStatus: vi.fn(() => () => undefined),
    ...overrides
  }
}

function baseConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    agentId: 'agent-1',
    taskId: 'task-1',
    workspaceDir: '/workspace',
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  sdkMocks.AgentListRunsMock.mockResolvedValue({ items: [] })
  sdkMocks.AgentMessagesListMock.mockResolvedValue([])
  sdkMocks.CursorModelsListMock.mockResolvedValue([])
})

describe('CursorSdkAdapter session lifecycle', () => {
  it('createSession creates a Cursor agent and returns its agentId as the session id', async () => {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    const fakeAgent = makeFakeAgent('cursor-agent-1')
    sdkMocks.AgentCreateMock.mockResolvedValue(fakeAgent)

    const sessionId = await adapter.createSession(baseConfig({ model: 'grok-4.5' }))

    expect(sessionId).toBe('cursor-agent-1')
    expect(sdkMocks.AgentCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      model: { id: 'grok-4.5' },
      local: expect.objectContaining({ cwd: '/workspace' })
    }))
  })

  it('maps an unset/"auto" model to the SDK\'s "default" sentinel', async () => {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    sdkMocks.AgentCreateMock.mockResolvedValue(makeFakeAgent('a1'))

    await adapter.createSession(baseConfig({ model: 'auto' }))
    expect(sdkMocks.AgentCreateMock).toHaveBeenCalledWith(expect.objectContaining({ model: { id: 'default' } }))

    await adapter.createSession(baseConfig({ model: undefined }))
    expect(sdkMocks.AgentCreateMock).toHaveBeenCalledWith(expect.objectContaining({ model: { id: 'default' } }))
  })

  it('resumeSession resumes the agent and hydrates persisted history', async () => {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    sdkMocks.AgentResumeMock.mockResolvedValue(makeFakeAgent('cursor-agent-1'))
    sdkMocks.AgentMessagesListMock.mockResolvedValue([
      { type: 'user', uuid: 'u1', agent_id: 'cursor-agent-1', message: { text: 'hello' } },
      { type: 'assistant', uuid: 'a1', agent_id: 'cursor-agent-1', message: 'hi there' }
    ])

    const messages = await adapter.resumeSession('cursor-agent-1', baseConfig())

    expect(sdkMocks.AgentResumeMock).toHaveBeenCalledWith('cursor-agent-1', expect.any(Object))
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe(MessageRole.USER)
    expect(messages[0].parts[0].text).toBe('hello')
    expect(messages[1].role).toBe(MessageRole.ASSISTANT)
    expect(messages[1].parts[0].text).toBe('hi there')
  })

  it('translates AgentNotFoundError on resume into the SESSION_GONE_MARKERS-recognized message', async () => {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    sdkMocks.AgentResumeMock.mockRejectedValue(new sdkMocks.AgentNotFoundError('agent_not_found: no such agent'))

    await expect(adapter.resumeSession('stale-acp-session-id', baseConfig()))
      .rejects.toThrow('Session no longer exists on server')
  })

  it('does NOT translate UnknownAgentError on resume (it is not a not-found signal)', async () => {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    sdkMocks.AgentResumeMock.mockRejectedValue(new sdkMocks.UnknownAgentError('something else went wrong'))

    await expect(adapter.resumeSession('session-1', baseConfig()))
      .rejects.toThrow('something else went wrong')
  })

  it('propagates other resume failures unchanged', async () => {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    sdkMocks.AgentResumeMock.mockRejectedValue(new Error('network blip'))

    await expect(adapter.resumeSession('session-1', baseConfig())).rejects.toThrow('network blip')
  })

  it('destroySession closes the agent and forgets the session', async () => {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    const fakeAgent = makeFakeAgent('a1')
    sdkMocks.AgentCreateMock.mockResolvedValue(fakeAgent)
    const sessionId = await adapter.createSession(baseConfig())

    await adapter.destroySession(sessionId, baseConfig())

    expect(fakeAgent.close).toHaveBeenCalledOnce()
    await expect(adapter.abortPrompt(sessionId, baseConfig())).rejects.toThrow('Session not found')
  })
})

describe('CursorSdkAdapter stuck-run recovery', () => {
  it('retries exactly once after cancelling a stuck run on a RESUMED session that hits AgentBusyError', async () => {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    const run = makeFakeRun('run-1')
    const fakeAgent = makeFakeAgent('a1', {
      send: vi.fn()
        .mockRejectedValueOnce(new sdkMocks.AgentBusyError('agent already has an active run in progress'))
        .mockResolvedValueOnce(run)
    })
    sdkMocks.AgentResumeMock.mockResolvedValue(fakeAgent)
    const stuckRun = makeFakeRun('stuck-run', { status: 'running' })
    sdkMocks.AgentListRunsMock.mockResolvedValue({ items: [stuckRun] })

    await adapter.resumeSession('a1', baseConfig())
    await adapter.sendPrompt('a1', [{ type: MessagePartType.TEXT, text: 'hi' }], baseConfig())

    expect(stuckRun.cancel).toHaveBeenCalledOnce()
    expect(fakeAgent.send).toHaveBeenCalledTimes(2)
  })

  it('never attempts stuck-run recovery on a freshly-created session', async () => {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    const fakeAgent = makeFakeAgent('a1', {
      send: vi.fn().mockRejectedValue(new sdkMocks.AgentBusyError('busy'))
    })
    sdkMocks.AgentCreateMock.mockResolvedValue(fakeAgent)

    await adapter.createSession(baseConfig())
    await adapter.sendPrompt('a1', [{ type: MessagePartType.TEXT, text: 'hi' }], baseConfig())

    expect(fakeAgent.send).toHaveBeenCalledTimes(1)
    expect(sdkMocks.AgentListRunsMock).not.toHaveBeenCalled()
    const status = await adapter.getStatus('a1', baseConfig())
    expect(status.type).toBe(SessionStatusType.ERROR)
  })
})

describe('CursorSdkAdapter delta → transcript mapping', () => {
  async function createdSessionWithSend() {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    let capturedOnDelta: ((args: { update: any }) => void) | undefined
    const run = makeFakeRun('run-1')
    const fakeAgent = makeFakeAgent('a1', {
      send: vi.fn(async (_msg: any, options: any) => {
        capturedOnDelta = options.onDelta ? (args: any) => options.onDelta({ update: args.update }) : undefined
        return run
      })
    })
    sdkMocks.AgentCreateMock.mockResolvedValue(fakeAgent)
    await adapter.createSession(baseConfig())
    await adapter.sendPrompt('a1', [{ type: MessagePartType.TEXT, text: 'hi' }], baseConfig())
    return { adapter, emit: (update: any) => capturedOnDelta!({ update }) }
  }

  it('accumulates text-delta into a growing TEXT part', async () => {
    const { adapter, emit } = await createdSessionWithSend()
    emit({ type: 'text-delta', text: 'Hel' })
    emit({ type: 'text-delta', text: 'lo' })
    const parts = await adapter.pollMessages('a1', new Set(), new Set(), new Map(), baseConfig())
    const textParts = parts.filter((p) => p.type === MessagePartType.TEXT && p.role === 'assistant')
    expect(textParts.at(-1)?.text).toBe('Hello')
  })

  it('accumulates thinking-delta into a REASONING part', async () => {
    const { adapter, emit } = await createdSessionWithSend()
    emit({ type: 'thinking-delta', text: 'pondering' })
    const parts = await adapter.pollMessages('a1', new Set(), new Set(), new Map(), baseConfig())
    const reasoning = parts.find((p) => p.type === MessagePartType.REASONING)
    expect(reasoning?.text).toBe('pondering')
  })

  it('projects a shell tool call into command/stdout/stderr/exit code', async () => {
    const { adapter, emit } = await createdSessionWithSend()
    emit({
      type: 'tool-call-completed',
      callId: 'call-1',
      toolCall: {
        type: 'shell',
        args: { command: 'ls -la' },
        result: { status: 'success', value: { exitCode: 0, signal: '', stdout: 'out', stderr: '', executionTime: 10 } }
      }
    })
    const parts = await adapter.pollMessages('a1', new Set(), new Set(), new Map(), baseConfig())
    const toolPart = parts.find((p) => p.id === 'call-1')
    expect(toolPart?.type).toBe(MessagePartType.TOOL)
    expect(toolPart?.tool?.name).toBe('shell')
    expect(toolPart?.tool?.status).toBe('success')
    expect(toolPart?.tool?.output).toMatchObject({ stdout: 'out', exitCode: 0 })
  })

  it('projects updateTodos into the todowrite/tool.todos convention', async () => {
    const { adapter, emit } = await createdSessionWithSend()
    emit({
      type: 'tool-call-completed',
      callId: 'call-2',
      toolCall: {
        type: 'updateTodos',
        args: { todos: [{ content: 'write tests', status: 'inProgress' }] },
        result: { status: 'success', value: { todos: [{ content: 'write tests', status: 'inProgress' }], totalCount: 1 } }
      }
    })
    const parts = await adapter.pollMessages('a1', new Set(), new Set(), new Map(), baseConfig())
    const todoPart = parts.find((p) => p.id === 'call-2')
    expect(todoPart?.type).toBe('todowrite')
    expect(todoPart?.tool?.todos).toEqual([{ id: 'todo-0', content: 'write tests', status: 'in_progress' }])
  })

  it('projects createPlan into the planreview convention with the plan text as output', async () => {
    const { adapter, emit } = await createdSessionWithSend()
    emit({
      type: 'tool-call-completed',
      callId: 'call-3',
      toolCall: { type: 'createPlan', args: { plan: '# My plan' }, result: { status: 'success', value: {} } }
    })
    const parts = await adapter.pollMessages('a1', new Set(), new Set(), new Map(), baseConfig())
    const planPart = parts.find((p) => p.id === 'call-3')
    expect(planPart?.type).toBe('planreview')
    expect(planPart?.tool?.output).toBe('# My plan')
  })

  it('projects an mcp tool call generically', async () => {
    const { adapter, emit } = await createdSessionWithSend()
    emit({
      type: 'tool-call-completed',
      callId: 'call-4',
      toolCall: {
        type: 'mcp',
        args: { providerIdentifier: 'github', toolName: 'list_issues', args: { repo: 'x' } },
        result: { status: 'success', value: { content: [{ text: { text: 'issue list' } }], isError: false } }
      }
    })
    const parts = await adapter.pollMessages('a1', new Set(), new Set(), new Map(), baseConfig())
    const mcpPart = parts.find((p) => p.id === 'call-4')
    expect(mcpPart?.tool?.name).toBe('github/list_issues')
    expect(mcpPart?.tool?.output).toBe('issue list')
  })

  it('never drops an unrecognized native tool-call kind — falls back to a generic tool part', async () => {
    const { adapter, emit } = await createdSessionWithSend()
    emit({
      type: 'tool-call-completed',
      callId: 'call-5',
      toolCall: { type: 'generateImage', args: { prompt: 'a cat' }, result: { status: 'success', value: { url: 'http://x' } } }
    })
    const parts = await adapter.pollMessages('a1', new Set(), new Set(), new Map(), baseConfig())
    const genPart = parts.find((p) => p.id === 'call-5')
    expect(genPart?.tool?.name).toBe('generateImage')
    expect(genPart?.tool?.input).toEqual({ prompt: 'a cat' })
  })

  it('updates the same logical tool part (by callId) across started → completed, not a new one', async () => {
    const { adapter, emit } = await createdSessionWithSend()
    emit({ type: 'tool-call-started', callId: 'call-6', toolCall: { type: 'read', args: { path: '/a.ts' } } })
    emit({
      type: 'tool-call-completed',
      callId: 'call-6',
      toolCall: { type: 'read', args: { path: '/a.ts' }, result: { status: 'success', value: { content: 'x', totalLines: 1, fileSize: 1 } } }
    })
    const parts = await adapter.pollMessages('a1', new Set(), new Set(), new Map(), baseConfig())
    const matching = parts.filter((p) => p.id === 'call-6')
    expect(matching).toHaveLength(2)
    expect(matching[0].update).toBe(false)
    expect(matching[1].update).toBe(true)
    expect(matching[0].tool?.status).toBe('running')
    expect(matching[1].tool?.status).toBe('success')
  })
})

describe('CursorSdkAdapter permission mapping', () => {
  it('maps "allow" with no workspace-write sandbox to full access', async () => {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    sdkMocks.AgentCreateMock.mockResolvedValue(makeFakeAgent('a1'))
    await adapter.createSession(baseConfig({ permissionMode: 'allow' }))
    expect(sdkMocks.AgentCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      local: expect.objectContaining({ autoReview: false, sandboxOptions: { enabled: false } })
    }))
  })

  it('maps "allow" + sandboxMode workspace-write to auto-accept-edits', async () => {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    sdkMocks.AgentCreateMock.mockResolvedValue(makeFakeAgent('a1'))
    await adapter.createSession(baseConfig({ permissionMode: 'allow', sandboxMode: 'workspace-write' }))
    expect(sdkMocks.AgentCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      local: expect.objectContaining({ autoReview: false, sandboxOptions: { enabled: true } })
    }))
  })

  it('maps "ask" (default) to ask-every-time', async () => {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    sdkMocks.AgentCreateMock.mockResolvedValue(makeFakeAgent('a1'))
    await adapter.createSession(baseConfig({ permissionMode: 'ask' }))
    expect(sdkMocks.AgentCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      local: expect.objectContaining({ autoReview: true, sandboxOptions: { enabled: true } })
    }))
  })
})

describe('CursorSdkAdapter MCP server translation', () => {
  it('translates stdio and http MCP server configs to the SDK shape', async () => {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    sdkMocks.AgentCreateMock.mockResolvedValue(makeFakeAgent('a1'))

    await adapter.createSession(baseConfig({
      mcpServers: {
        local: { type: 'stdio', command: 'my-server', args: ['--flag'], env: { FOO: 'bar' } },
        remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } }
      }
    }))

    expect(sdkMocks.AgentCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      mcpServers: {
        local: { type: 'stdio', command: 'my-server', args: ['--flag'], env: { FOO: 'bar' } },
        remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } }
      }
    }))
  })

  it('recomputes MCP servers fresh on every sendPrompt call, not cached from session creation', async () => {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    const run = makeFakeRun('run-1')
    const fakeAgent = makeFakeAgent('a1', { send: vi.fn(async () => run) })
    sdkMocks.AgentCreateMock.mockResolvedValue(fakeAgent)

    await adapter.createSession(baseConfig({ mcpServers: undefined }))
    await adapter.sendPrompt('a1', [{ type: MessagePartType.TEXT, text: 'hi' }], baseConfig({
      mcpServers: { later: { type: 'sse', url: 'https://example.com/sse' } }
    }))

    expect(fakeAgent.send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      mcpServers: { later: { type: 'sse', url: 'https://example.com/sse' } }
    }))
  })
})

describe('CursorSdkAdapter usage reporting', () => {
  it('reports token usage via onUsage after the run completes, keyed by run.id', async () => {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: 15, reasoningTokens: 2 }
    const run = makeFakeRun('run-usage-1', { wait: vi.fn(async () => ({ id: 'run-usage-1', status: 'finished', result: 'ok', usage, model: { id: 'grok-4.5' } })) })
    const fakeAgent = makeFakeAgent('a1', {
      send: vi.fn(async () => run),
      getUsage: vi.fn(async () => ({ usage, cost: { rawCostCents: 100, chargedCents: 50 }, runs: [{ runId: 'run-usage-1', usage, cost: { rawCostCents: 100, chargedCents: 50 } }] }))
    })
    sdkMocks.AgentCreateMock.mockResolvedValue(fakeAgent)

    const onUsage = vi.fn()
    adapter.onUsage = onUsage
    await adapter.createSession(baseConfig())
    await adapter.sendPrompt('a1', [{ type: MessagePartType.TEXT, text: 'hi' }], baseConfig())

    await vi.waitFor(() => expect(onUsage).toHaveBeenCalled())
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'discrete',
      provider: 'cursor',
      items: [expect.objectContaining({
        sourceKey: 'run-usage-1',
        model: 'grok-4.5',
        usage: expect.objectContaining({ inputTokens: 10, outputTokens: 5, reasoningTokens: 2, costUsd: 0.5 })
      })]
    }))
  })

  it('reports costUsd: null when the cost fetch fails, without throwing', async () => {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 }
    const run = makeFakeRun('run-usage-2', { wait: vi.fn(async () => ({ id: 'run-usage-2', status: 'finished', usage })) })
    const fakeAgent = makeFakeAgent('a1', { send: vi.fn(async () => run), getUsage: vi.fn(async () => { throw new Error('not ready') }) })
    sdkMocks.AgentCreateMock.mockResolvedValue(fakeAgent)
    const onUsage = vi.fn()
    adapter.onUsage = onUsage
    await adapter.createSession(baseConfig())
    await adapter.sendPrompt('a1', [{ type: MessagePartType.TEXT, text: 'hi' }], baseConfig())

    await vi.waitFor(() => expect(onUsage).toHaveBeenCalled())
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({ sourceKey: 'run-usage-2', usage: expect.objectContaining({ costUsd: null }) })]
    }))
  })
})

describe('CursorSdkAdapter usage-limit mapping', () => {
  it('maps a RateLimitError thrown from send() to a usage-limit ERROR status with resetAt: null', async () => {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    const fakeAgent = makeFakeAgent('a1', { send: vi.fn().mockRejectedValue(new sdkMocks.RateLimitError('Too many requests, usage limits exceeded')) })
    sdkMocks.AgentCreateMock.mockResolvedValue(fakeAgent)
    await adapter.createSession(baseConfig())

    await adapter.sendPrompt('a1', [{ type: MessagePartType.TEXT, text: 'hi' }], baseConfig())

    const status = await adapter.getStatus('a1', baseConfig())
    expect(status.type).toBe(SessionStatusType.ERROR)
    expect(status.usageLimit).toEqual({ resetAt: null })
  })
})

describe('CursorSdkAdapter model catalog', () => {
  it('fetches the live catalog and caches it on success for 30 minutes', async () => {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    sdkMocks.CursorModelsListMock.mockResolvedValue([{ id: 'grok-4.5', displayName: 'Grok 4.5' }])

    const first = await adapter.getProviders()
    expect(first?.providers[0]).toMatchObject({ id: 'cursor', models: [{ id: 'grok-4.5', name: 'Grok 4.5' }] })

    sdkMocks.CursorModelsListMock.mockResolvedValue([{ id: 'other-model', displayName: 'Other' }])
    const second = await adapter.getProviders()
    expect(second?.providers[0].models).toEqual([{ id: 'grok-4.5', name: 'Grok 4.5' }])
    expect(sdkMocks.CursorModelsListMock).toHaveBeenCalledTimes(1)
  })

  it('does NOT cache a failed fetch — retries immediately on the next call', async () => {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    sdkMocks.CursorModelsListMock.mockRejectedValueOnce(new Error('network down'))

    const first = await adapter.getProviders()
    expect(first?.providers[0].models.map((m) => m.id)).toEqual(['composer-2.5', 'grok-4.5'])

    sdkMocks.CursorModelsListMock.mockResolvedValueOnce([{ id: 'grok-4.5', displayName: 'Grok 4.5' }])
    const second = await adapter.getProviders()
    expect(second?.providers[0].models).toEqual([{ id: 'grok-4.5', name: 'Grok 4.5' }])
    expect(sdkMocks.CursorModelsListMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT cache an empty result', async () => {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    sdkMocks.CursorModelsListMock.mockResolvedValueOnce([])
    await adapter.getProviders()
    sdkMocks.CursorModelsListMock.mockResolvedValueOnce([{ id: 'grok-4.5', displayName: 'Grok 4.5' }])
    await adapter.getProviders()
    expect(sdkMocks.CursorModelsListMock).toHaveBeenCalledTimes(2)
  })
})

describe('cursor-sdk-auth: API key resolution precedence', () => {
  it('uses the explicit apiKeys.cursor value when authMethod is api_key', async () => {
    const store = { load: vi.fn(async () => undefined), save: vi.fn(), clear: vi.fn() }
    const key = await resolveCursorApiKey({ authMethod: 'api_key', apiKeys: { cursor: 'key-from-config' } }, store)
    expect(key).toBe('key-from-config')
  })

  it('falls back to CURSOR_API_KEY env when authMethod is api_key but no explicit key is configured', async () => {
    const original = process.env.CURSOR_API_KEY
    process.env.CURSOR_API_KEY = 'env-key'
    try {
      const store = { load: vi.fn(async () => undefined), save: vi.fn(), clear: vi.fn() }
      const key = await resolveCursorApiKey({ authMethod: 'api_key' }, store)
      expect(key).toBe('env-key')
    } finally {
      if (original === undefined) delete process.env.CURSOR_API_KEY
      else process.env.CURSOR_API_KEY = original
    }
  })

  it('throws when api_key mode is requested but no key is configured anywhere', async () => {
    const original = process.env.CURSOR_API_KEY
    delete process.env.CURSOR_API_KEY
    try {
      const store = { load: vi.fn(async () => undefined), save: vi.fn(), clear: vi.fn() }
      await expect(resolveCursorApiKey({ authMethod: 'api_key' }, store)).rejects.toThrow(/CURSOR_API_KEY/)
    } finally {
      if (original !== undefined) process.env.CURSOR_API_KEY = original
    }
  })

  it('uses the stored browser-login credential in subscription mode, ignoring ambient CURSOR_API_KEY', async () => {
    const original = process.env.CURSOR_API_KEY
    process.env.CURSOR_API_KEY = 'should-be-ignored'
    try {
      const store = { load: vi.fn(async () => ({ version: 1 as const, backendUrl: 'https://api2.cursor.sh', apiKey: 'stored-key', createdAtMs: Date.now() })), save: vi.fn(), clear: vi.fn() }
      const key = await resolveCursorApiKey({ authMethod: 'subscription' }, store)
      expect(key).toBe('stored-key')
    } finally {
      if (original === undefined) delete process.env.CURSOR_API_KEY
      else process.env.CURSOR_API_KEY = original
    }
  })

  it('returns undefined in subscription mode when nothing is stored yet', async () => {
    const store = { load: vi.fn(async () => undefined), save: vi.fn(), clear: vi.fn() }
    const key = await resolveCursorApiKey({ authMethod: 'subscription' }, store)
    expect(key).toBeUndefined()
  })

  it('returns undefined when the stored credential has expired', async () => {
    const store = { load: vi.fn(async () => ({ version: 1 as const, backendUrl: 'x', apiKey: 'expired-key', apiKeyExpiresAtMs: Date.now() - 1000, createdAtMs: Date.now() - 2000 })), save: vi.fn(), clear: vi.fn() }
    const key = await resolveCursorApiKey({ authMethod: 'subscription' }, store)
    expect(key).toBeUndefined()
  })

  it('hasExplicitApiKey reflects the same precedence used for refusing browser login/logout', () => {
    expect(hasExplicitApiKey({ authMethod: 'api_key' })).toBe(true)
    expect(hasExplicitApiKey({ authMethod: 'subscription', apiKeys: { cursor: 'x' } })).toBe(false)
    expect(hasExplicitApiKey({ authMethod: undefined, apiKeys: { cursor: 'x' } })).toBe(true)
    expect(hasExplicitApiKey(undefined)).toBe(false)
  })
})

describe('DbSdkCredentialStore round-trip', () => {
  it('saves and loads credentials through the encrypted settings row', async () => {
    const db = makeMockDb()
    const store = new DbSdkCredentialStore(db)
    await store.save({ version: 1, backendUrl: 'https://api2.cursor.sh', apiKey: 'abc123', email: 'me@example.com', createdAtMs: 123 })
    const loaded = await store.load()
    expect(loaded).toEqual({ version: 1, backendUrl: 'https://api2.cursor.sh', apiKey: 'abc123', email: 'me@example.com', createdAtMs: 123 })
  })

  it('clear() removes the credential so a later load() is undefined', async () => {
    const db = makeMockDb()
    const store = new DbSdkCredentialStore(db)
    await store.save({ version: 1, backendUrl: 'x', apiKey: 'y', createdAtMs: 1 })
    await store.clear()
    expect(await store.load()).toBeUndefined()
  })

  it('treats a corrupted or foreign-shaped stored value as logged out, not a throw', async () => {
    const db = makeMockDb()
    db.setSetting('cursor-sdk-credentials', Buffer.from('not json').toString('base64'))
    const store = new DbSdkCredentialStore(db)
    await expect(store.load()).resolves.toBeUndefined()

    db.setSetting('cursor-sdk-credentials', Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64'))
    await expect(store.load()).resolves.toBeUndefined()
  })
})

describe('CursorSdkAdapter browser login', () => {
  it('happy path: resolves with the login URL, then saves credentials to the persistent store only after login() resolves', async () => {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    let savedCreds: unknown
    const originalSave = DbSdkCredentialStore.prototype.save
    vi.spyOn(DbSdkCredentialStore.prototype, 'save').mockImplementation(async function (this: any, creds: any) {
      savedCreds = creds
      return originalSave.call(this, creds)
    })

    sdkMocks.CursorAuthLoginMock.mockImplementation(async (options: any) => {
      options.onLoginUrl('https://cursor.example/login/xyz')
      return { apiKey: 'minted-key', email: 'me@example.com', apiKeyExpiresAtMs: Date.now() + 1000 }
    })

    const onLoginComplete = vi.fn()
    adapter.onLoginComplete = onLoginComplete

    const { url } = await adapter.startBrowserLogin()
    expect(url).toBe('https://cursor.example/login/xyz')

    await vi.waitFor(() => expect(onLoginComplete).toHaveBeenCalledWith({ success: true, email: 'me@example.com' }))
    expect(savedCreds).toMatchObject({ apiKey: 'minted-key', email: 'me@example.com' })
  })

  it('refuses to start while CURSOR_API_KEY is set', async () => {
    const original = process.env.CURSOR_API_KEY
    process.env.CURSOR_API_KEY = 'some-key'
    try {
      const db = makeMockDb()
      const adapter = new CursorSdkAdapter({ db })
      await expect(adapter.startBrowserLogin()).rejects.toThrow(/CURSOR_API_KEY/)
    } finally {
      if (original === undefined) delete process.env.CURSOR_API_KEY
      else process.env.CURSOR_API_KEY = original
    }
  })

  it('cancelBrowserLogin() aborts the in-flight login and reports failure via onLoginComplete', async () => {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    let capturedSignal: AbortSignal | undefined

    sdkMocks.CursorAuthLoginMock.mockImplementation((options: any) => {
      capturedSignal = options.signal
      options.onLoginUrl('https://cursor.example/login/abc')
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new sdkMocks.AuthenticationError('aborted')))
      })
    })

    const onLoginComplete = vi.fn()
    adapter.onLoginComplete = onLoginComplete
    await adapter.startBrowserLogin()
    adapter.cancelBrowserLogin()

    await vi.waitFor(() => expect(onLoginComplete).toHaveBeenCalledWith(expect.objectContaining({ success: false })))
    expect(capturedSignal?.aborted).toBe(true)
  })

  it('times out an abandoned login after the timeout window and reports failure', async () => {
    vi.useFakeTimers()
    try {
      const db = makeMockDb()
      const adapter = new CursorSdkAdapter({ db })
      sdkMocks.CursorAuthLoginMock.mockImplementation((options: any) => {
        options.onLoginUrl('https://cursor.example/login/timeout')
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new sdkMocks.AuthenticationError('timed out')))
        })
      })
      const onLoginComplete = vi.fn()
      adapter.onLoginComplete = onLoginComplete

      await adapter.startBrowserLogin()
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)

      expect(onLoginComplete).toHaveBeenCalledWith(expect.objectContaining({ success: false }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('logout() clears the persistent credential and is refused while CURSOR_API_KEY is set', async () => {
    const db = makeMockDb()
    const adapter = new CursorSdkAdapter({ db })
    db.setSetting('cursor-sdk-credentials', Buffer.from(JSON.stringify({ version: 1, backendUrl: 'x', apiKey: 'y', createdAtMs: 1 })).toString('base64'))

    await adapter.logout()
    expect(db.getSetting('cursor-sdk-credentials')).toBeUndefined()

    const original = process.env.CURSOR_API_KEY
    process.env.CURSOR_API_KEY = 'k'
    try {
      await expect(adapter.logout()).rejects.toThrow(/CURSOR_API_KEY/)
    } finally {
      if (original === undefined) delete process.env.CURSOR_API_KEY
      else process.env.CURSOR_API_KEY = original
    }
  })
})

describe('CursorSdkAdapter.whoAmI', () => {
  function storeCreds(db: ReturnType<typeof makeMockDb>, overrides: Partial<Record<string, unknown>> = {}): void {
    db.setSetting('cursor-sdk-credentials', Buffer.from(JSON.stringify({
      version: 1,
      backendUrl: 'x',
      apiKey: 'stored-key',
      email: 'stored@example.com',
      createdAtMs: 1,
      ...overrides
    })).toString('base64'))
  }

  it('reports not signed in when no credential is stored', async () => {
    const adapter = new CursorSdkAdapter({ db: makeMockDb() })
    await expect(adapter.whoAmI()).resolves.toEqual({ authenticated: false, reason: 'Not signed in' })
  })

  it('reports not signed in when the stored credential has expired', async () => {
    const db = makeMockDb()
    storeCreds(db, { apiKeyExpiresAtMs: Date.now() - 1000 })
    const adapter = new CursorSdkAdapter({ db })
    await expect(adapter.whoAmI()).resolves.toEqual({ authenticated: false, reason: 'Not signed in' })
  })

  it('reports authenticated with the live email when the lookup succeeds', async () => {
    const db = makeMockDb()
    storeCreds(db)
    sdkMocks.CursorMeMock.mockResolvedValueOnce({ userEmail: 'live@example.com' })
    const adapter = new CursorSdkAdapter({ db })
    await expect(adapter.whoAmI()).resolves.toEqual({ authenticated: true, email: 'live@example.com' })
    expect(sdkMocks.CursorMeMock).toHaveBeenCalledWith({ apiKey: 'stored-key' })
  })

  it('reports not authenticated when the stored credential is actually invalid (AuthenticationError)', async () => {
    const db = makeMockDb()
    storeCreds(db)
    sdkMocks.CursorMeMock.mockRejectedValueOnce(new sdkMocks.AuthenticationError('revoked'))
    const adapter = new CursorSdkAdapter({ db })
    await expect(adapter.whoAmI()).resolves.toEqual({ authenticated: false, reason: 'Not authenticated' })
  })

  it('stays authenticated on a transient lookup failure instead of bouncing back to "sign in again"', async () => {
    // Regression: a stored credential is real evidence of sign-in. A
    // network blip or momentary backend hiccup verifying it live (most
    // likely right after a fresh sign-in) must not flip the UI back to
    // "not signed in" — only a definite AuthenticationError should.
    const db = makeMockDb()
    storeCreds(db)
    sdkMocks.CursorMeMock.mockRejectedValueOnce(new Error('ECONNRESET'))
    const adapter = new CursorSdkAdapter({ db })
    const result = await adapter.whoAmI()
    expect(result.authenticated).toBe(true)
    expect(result.email).toBe('stored@example.com')
    expect(result.reason).toMatch(/could not reach cursor/i)
  })

  it('reports a specific, actionable reason when the account is signed in but lacks a plan the SDK requires', async () => {
    // Seen live as a 403 `plan_required` from Cursor.me() for a free-tier
    // account — permanent, not a network blip, so it must not collapse into
    // the generic "could not reach Cursor" fallback above.
    const db = makeMockDb()
    storeCreds(db)
    const planError = new sdkMocks.CursorSdkError('[plan_required] Cloud Agent is not available for free users. Please upgrade to Pro.')
    Object.assign(planError, { code: 'plan_required' })
    sdkMocks.CursorMeMock.mockRejectedValueOnce(planError)
    const adapter = new CursorSdkAdapter({ db })
    const result = await adapter.whoAmI()
    expect(result.authenticated).toBe(true)
    expect(result.email).toBe('stored@example.com')
    expect(result.reason).toMatch(/plan doesn't support the sdk/i)
    expect(result.reason).toMatch(/plan_required/i)
  })
})
