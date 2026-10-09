/**
 * Tests for the generic ACP client/adapter.
 *
 * Covers: JSON-RPC framing, turn-based message conversion, permission
 * handling, usage/error classification, v1-vs-v2 protocol negotiation,
 * mcpServers passthrough, fs scoping, image content gating, and wrapper
 * hook dispatch. Cursor/Codex-specific tests (model remap, `cursor-agent
 * --version` health check, codex binary resolution) were deleted along
 * with the hardcoded branches they exercised — see agent-manager.test.ts
 * for the one remaining Cursor construction call site.
 */

import { ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { mkdtempSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AcpAgentAdapter } from './acp-adapter'
import { SessionStatusType, MessagePartType, MessagePart, SessionConfig } from './coding-agent-adapter'
import { registerWrapperHooksForTests, unregisterWrapperHooksForTests } from '../acp-registry/wrapper-hooks'

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { write: vi.fn() },
    on: vi.fn(),
    kill: vi.fn()
  }))
}))

interface JsonRpcRequestForTest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
}

// Minimal session type for direct private-method tests (mirrors the private AcpSession).
interface AcpSessionForTest {
  sessionId: string
  acpSessionId: string | null
  process: ChildProcess
  stdoutBuffer: string
  status: SessionStatusType
  messageBuffer: unknown[]
  permanentMessages: unknown[]
  pendingRequests: Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>
  nextRequestId: number
  pendingApproval: unknown | null
  config: { permissionMode?: 'ask' | 'allow'; model?: string; taskId?: string; agentId?: string; workspaceDir?: string }
  promptRequestId: number | null
  responseCounter: number
  currentUserTurnId: number
  lastChunkTime: number | null
  currentTurnId: number
  lastSessionUpdateType: string | null
  activeTurnId: number | null
  pendingAssistantTurnSplit: boolean
  toolCallMetadata: Map<string, { name: string; input: string; title?: string }>
  lastError: string | null
  createdInApp: boolean
  usageCostUsd: number | null
  generation: 'v1' | 'v2'
  capabilities: {
    canResume: boolean
    mcpHttp: boolean
    mcpSse: boolean
    promptImage: boolean
    supportsLogout: boolean
    hasDedicatedSetMode: boolean
  }
  configOptions: unknown[]
  currentModeId: string | null
  availableCommands: unknown[]
  pendingAuth: unknown | null
  terminals: Map<string, unknown>
  usageLimit?: unknown
  lastAuthMethods?: unknown[]
}

interface AcpAgentAdapterPrivate {
  convertAcpEventToMessageParts(
    event: unknown,
    seenMessageIds: Set<string>,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>,
    session?: AcpSessionForTest
  ): MessagePart[]
  handlePermissionRequest(session: AcpSessionForTest, request: JsonRpcRequestForTest): void
  sendRpcResponse(session: AcpSessionForTest, id: string | number, result: unknown): void
  updateSessionStatus(session: AcpSessionForTest, notification: unknown): void
  handleRpcMessage(session: AcpSessionForTest, message: unknown): void
  handlePossibleProviderError(session: AcpSessionForTest, error: { code: number; message: string; data?: unknown }): boolean
  sendRpcRequest(session: AcpSessionForTest, method: string, params?: unknown): Promise<unknown>
  buildPromptContentBlocks(parts: MessagePart[], session: AcpSessionForTest): unknown[]
  convertMcpServers(servers: Record<string, unknown> | undefined, session: AcpSessionForTest): unknown[]
  debugRpcLogs: boolean
}

function adapterPrivate(adapter: AcpAgentAdapter): AcpAgentAdapterPrivate {
  return adapter as unknown as AcpAgentAdapterPrivate
}

function createMockSession(sessionId: string): AcpSessionForTest {
  return {
    sessionId,
    acpSessionId: null,
    process: {} as unknown as ChildProcess,
    stdoutBuffer: '',
    status: SessionStatusType.IDLE,
    messageBuffer: [],
    permanentMessages: [],
    pendingRequests: new Map(),
    nextRequestId: 1,
    pendingApproval: null,
    config: { permissionMode: 'ask' },
    promptRequestId: null,
    responseCounter: 0,
    currentUserTurnId: 0,
    lastChunkTime: null,
    currentTurnId: 0,
    lastSessionUpdateType: null,
    activeTurnId: null,
    pendingAssistantTurnSplit: false,
    toolCallMetadata: new Map(),
    lastError: null,
    createdInApp: true,
    usageCostUsd: null,
    generation: 'v1',
    capabilities: { canResume: false, mcpHttp: false, mcpSse: false, promptImage: false, supportsLogout: false, hasDedicatedSetMode: true },
    configOptions: [],
    currentModeId: null,
    availableCommands: [],
    pendingAuth: null,
    terminals: new Map()
  }
}

/** A fake ACP agent process driven entirely by a per-method response table. */
function createFakeProcess(handlers: Record<string, (params: unknown) => unknown> = {}) {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const proc = new EventEmitter() as unknown as ChildProcess & { stdin: { write: (data: string, cb?: (err?: Error) => void) => void } }
  const written: string[] = []
  ;(proc as unknown as Record<string, unknown>).stdout = stdout
  ;(proc as unknown as Record<string, unknown>).stderr = stderr
  ;(proc as unknown as Record<string, unknown>).stdin = {
    write: (data: string, cb?: (err?: Error) => void) => {
      written.push(data.trim())
      const msg = JSON.parse(data.trim())
      if (msg.method && msg.id !== undefined && handlers[msg.method]) {
        Promise.resolve(handlers[msg.method](msg.params)).then((result) => {
          stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n'))
        })
      }
      cb?.()
    }
  }
  ;(proc as unknown as Record<string, unknown>).kill = vi.fn()
  return { proc, stdout, written }
}

const v1InitResponse = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, mcpCapabilities: { http: false, sse: false }, promptCapabilities: { image: false } },
  agentInfo: { name: 'fake-agent', version: '0.0.1' }
}

const v2InitResponse = {
  protocolVersion: 2,
  info: { name: 'fake-agent', version: '0.0.1' },
  capabilities: { mcpCapabilities: { http: true, sse: false }, promptCapabilities: { image: true } }
}

async function createTestSession(adapter: AcpAgentAdapter, spawnMock: ReturnType<typeof vi.fn>, handlers: Record<string, (params: unknown) => unknown>, config: Partial<SessionConfig> = {}) {
  const { proc, written } = createFakeProcess(handlers)
  spawnMock.mockReturnValue(proc)
  const sessionId = await adapter.createSession({
    agentId: 'agent-1',
    taskId: 'task-1',
    workspaceDir: '/tmp',
    ...config
  } as SessionConfig)
  return { sessionId, written }
}

describe('AcpAgentAdapter - Permission handling', () => {
  let adapter: AcpAgentAdapter

  beforeEach(() => { adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [] }) })

  it('stores pending approval when permission mode is ask', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('s1')
    session.config.permissionMode = 'ask'

    priv.handlePermissionRequest(session, {
      jsonrpc: '2.0', id: 'req-1', method: 'session/request_permission',
      params: {
        toolCall: { rawInput: { reason: 'Run ls' }, toolCallId: 'tool-1', kind: 'shell' },
        options: [{ optionId: 'approved', name: 'Yes', kind: 'allow_once' }, { optionId: 'abort', name: 'No', kind: 'deny' }]
      }
    })

    expect(session.pendingApproval).toEqual({
      requestId: 'req-1', toolCallId: 'tool-1', question: 'Run ls',
      options: [{ optionId: 'approved', name: 'Yes', kind: 'allow_once' }, { optionId: 'abort', name: 'No', kind: 'deny' }]
    })
  })

  it('auto-approves when permission mode is allow', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('s2')
    session.config.permissionMode = 'allow'
    const spy = vi.spyOn(priv, 'sendRpcResponse')

    priv.handlePermissionRequest(session, {
      jsonrpc: '2.0', id: 'req-2', method: 'session/request_permission',
      params: {
        toolCall: { rawInput: { reason: 'Run npm test' }, toolCallId: 'tool-2', kind: 'shell' },
        options: [
          { optionId: 'approved-for-session', name: 'Always', kind: 'allow_session' },
          { optionId: 'approved', name: 'Yes', kind: 'allow_once' }
        ]
      }
    })

    expect(session.pendingApproval).toBeNull()
    expect(spy).toHaveBeenCalledWith(session, 'req-2', { result: { outcome: { outcome: 'selected', optionId: 'approved-for-session' } } })
  })

  it('respondToApproval sends the selected option and clears pending state', async () => {
    const session = createMockSession('s3')
    session.pendingApproval = { requestId: 'req-3', toolCallId: 'tool-3', question: 'q', options: [{ optionId: 'approved', name: 'Yes', kind: 'allow_once' }] }
    const priv = adapterPrivate(adapter)
    ;(priv as unknown as { sessions: Map<string, unknown> }).sessions = new Map([['s3', session]])
    const spy = vi.spyOn(priv, 'sendRpcResponse')

    await adapter.respondToApproval('s3', true)

    expect(spy).toHaveBeenCalledWith(session, 'req-3', { result: { outcome: { outcome: 'selected', optionId: 'approved' } } })
    expect(adapter.getPendingApproval('s3')).toBeNull()
  })
})

describe('AcpAgentAdapter - Turn detection', () => {
  let adapter: AcpAgentAdapter

  beforeEach(() => {
    adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [] })
    vi.useFakeTimers()
  })
  afterEach(() => { vi.useRealTimers() })

  it('uses the same turn ID for messages arriving within 2 seconds', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('turn-1')
    const seenPartIds = new Set<string>()
    const contentLengths = new Map<string, string>()

    priv.convertAcpEventToMessageParts(
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } } } },
      new Set(), seenPartIds, contentLengths, session
    )
    vi.advanceTimersByTime(1000)
    const parts = priv.convertAcpEventToMessageParts(
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' world' } } } },
      new Set(), seenPartIds, contentLengths, session
    )

    expect(parts[0].id).toBe('agent-response-1')
    expect(parts[0].update).toBe(true)
  })

  it('increments the turn ID after a 2+ second gap', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('turn-2')
    const seenPartIds = new Set<string>()
    const contentLengths = new Map<string, string>()

    priv.convertAcpEventToMessageParts(
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'First' } } } },
      new Set(), seenPartIds, contentLengths, session
    )
    vi.advanceTimersByTime(3000)
    const parts = priv.convertAcpEventToMessageParts(
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Second' } } } },
      new Set(), seenPartIds, contentLengths, session
    )

    expect(parts[0].id).toBe('agent-response-2')
  })
})

describe('AcpAgentAdapter - Tool call conversion', () => {
  let adapter: AcpAgentAdapter
  beforeEach(() => { adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [] }) })

  it('emits an in-progress tool part, then a completed update', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('tool-1')
    const seenPartIds = new Set<string>()

    const inProgress = priv.convertAcpEventToMessageParts(
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', kind: 'exec_command', status: 'in_progress', rawInput: { command: 'ls -la' } } } },
      new Set(), seenPartIds, new Map(), session
    )
    expect(inProgress[0].tool?.status).toBe('running')
    expect(inProgress[0].tool?.name).toBe('command')
    expect(inProgress[0].tool?.title).toBe('ls -la')

    const completed = priv.convertAcpEventToMessageParts(
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', rawOutput: { stdout: 'file.txt' } } } },
      new Set(), seenPartIds, new Map(), session
    )
    expect(completed[0].tool?.status).toBe('completed')
    expect(completed[0].tool?.output).toBe('file.txt')
    expect(completed[0].update).toBe(true)
  })

  it('normalizes update_plan into a plan tool title', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('tool-2')
    const parts = priv.convertAcpEventToMessageParts(
      {
        jsonrpc: '2.0', method: 'session/update',
        params: { update: { sessionUpdate: 'tool_call', toolCallId: 'tc-2', kind: 'update_plan', status: 'in_progress', rawInput: { plan: [{ step: 'Write tests' }, { step: 'Run them' }] } } }
      },
      new Set(), new Set(), new Map(), session
    )
    expect(parts[0].tool?.name).toBe('plan')
    expect(parts[0].tool?.title).toBe('2 steps: Write tests')
  })
})

describe('AcpAgentAdapter - plan session update maps to todowrite', () => {
  it('maps a `plan` session update into the existing tool.todos convention', () => {
    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [] })
    const priv = adapterPrivate(adapter)
    const session = createMockSession('plan-1')
    const parts = priv.convertAcpEventToMessageParts(
      {
        jsonrpc: '2.0', method: 'session/update',
        params: { update: { sessionUpdate: 'plan', entries: [{ content: 'Step one', priority: 'high', status: 'pending' }] } }
      },
      new Set(), new Set(), new Map(), session
    )
    expect(parts[0].type).toBe('todowrite')
    expect(parts[0].tool?.todos).toEqual([{ id: 'plan-0', content: 'Step one', status: 'pending', priority: 'high' }])
  })
})

describe('AcpAgentAdapter - Non-content updates must not fragment assistant turns', () => {
  it('available_commands_update between chunks does not start a new turn', () => {
    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [] })
    const priv = adapterPrivate(adapter)
    const session = createMockSession('frag-1')
    const seenPartIds = new Set<string>()
    const contentLengths = new Map<string, string>()

    priv.convertAcpEventToMessageParts(
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Part 1' } } } },
      new Set(), seenPartIds, contentLengths, session
    )
    priv.convertAcpEventToMessageParts(
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'available_commands_update', availableCommands: [] } } },
      new Set(), seenPartIds, contentLengths, session
    )
    const parts = priv.convertAcpEventToMessageParts(
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Part 2' } } } },
      new Set(), seenPartIds, contentLengths, session
    )
    expect(parts[0].id).toBe('agent-response-1')
  })
})

describe('AcpAgentAdapter - Provider error classification', () => {
  let adapter: AcpAgentAdapter
  beforeEach(() => { adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [] }) })

  it('falls back to generic rate-limit/usage-limit wording when no wrapper hook is set', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('err-1')

    const handled = priv.handlePossibleProviderError(session, { code: -32000, message: 'Rate limit exceeded, slow down' })
    expect(handled).toBe(true)
    expect(session.status).toBe(SessionStatusType.ERROR)
    expect(session.lastError).toContain('Rate limit reached')
  })

  it('treats an unrelated error as unhandled (not a quota/rate error)', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('err-2')
    const handled = priv.handlePossibleProviderError(session, { code: -32000, message: 'Connection refused' })
    expect(handled).toBe(false)
    expect(session.status).toBe(SessionStatusType.IDLE)
  })

  it('does not persist a transient quota error into permanent history', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('err-3')
    priv.handlePossibleProviderError(session, { code: -32000, message: 'quota exceeded for account' })
    expect(session.messageBuffer).toHaveLength(1)
    expect(session.permanentMessages).toHaveLength(0)
  })

  it('uses a wrapper hook classifyError when provided', () => {
    registerWrapperHooksForTests('fake-wrapper-agent', { classifyError: () => 'usage-limit' })
    const wrapped = new AcpAgentAdapter({ command: 'fake-agent', args: [], registryAgentId: 'fake-wrapper-agent' })
    const priv = adapterPrivate(wrapped)
    const session = createMockSession('err-4')
    const handled = priv.handlePossibleProviderError(session, { code: -32000, message: 'some unrelated wording' })
    expect(handled).toBe(true)
    expect(session.lastError).toContain('Quota exceeded')
    unregisterWrapperHooksForTests('fake-wrapper-agent')
  })

  it('folds a wrapper handleExtensionNotification retryClass into the usage-limit/retry path', () => {
    registerWrapperHooksForTests('fake-retry-agent', {
      handleExtensionNotification: (method) => (method === 'vendor/retry' ? { retryClass: 'rate-limit' } : undefined)
    })
    const wrapped = new AcpAgentAdapter({ command: 'fake-agent', args: [], registryAgentId: 'fake-retry-agent' })
    const priv = adapterPrivate(wrapped)
    const session = createMockSession('err-5')
    priv.handleRpcMessage(session, { jsonrpc: '2.0', method: 'vendor/retry', params: { cause: 'rate_limited' } })
    expect(session.status).toBe(SessionStatusType.RETRY)
    expect(session.usageLimit).toEqual({ resetAt: null })
    unregisterWrapperHooksForTests('fake-retry-agent')
  })
})

describe('AcpAgentAdapter - getStatus', () => {
  it('returns the lastError message when the session is in error state', async () => {
    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [] })
    const priv = adapterPrivate(adapter)
    const session = createMockSession('status-1')
    session.status = SessionStatusType.ERROR
    session.lastError = 'boom'
    ;(priv as unknown as { sessions: Map<string, unknown> }).sessions = new Map([['status-1', session]])

    const status = await adapter.getStatus('status-1', {} as SessionConfig)
    expect(status).toEqual({ type: SessionStatusType.ERROR, message: 'boom' })
  })

  it('reports an error for an unknown session', async () => {
    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [] })
    const status = await adapter.getStatus('nope', {} as SessionConfig)
    expect(status.type).toBe(SessionStatusType.ERROR)
  })
})

describe('AcpAgentAdapter - probeUsageLimits default', () => {
  it('resolves to null for any generic ACP agent by default', async () => {
    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [] })
    expect(await adapter.probeUsageLimits()).toBeNull()
  })

  it('can be overridden per instance (e.g. a Cursor-style shim)', async () => {
    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [] })
    adapter.probeUsageLimits = async () => ({ provider: 'cursor', checkedAt: 'now', windows: [], unavailable: null }) as never
    expect((await adapter.probeUsageLimits())?.provider).toBe('cursor')
  })
})

describe('AcpAgentAdapter - v1/v2 protocol negotiation', () => {
  let spawnMock: ReturnType<typeof vi.fn>
  beforeEach(async () => {
    const cp = await import('child_process')
    spawnMock = cp.spawn as unknown as ReturnType<typeof vi.fn>
  })

  it('detects v1 from the agentCapabilities/agentInfo shape and uses session/load to resume', async () => {
    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [] })
    const handlers: Record<string, (params: unknown) => unknown> = {
      initialize: () => v1InitResponse,
      'session/new': () => ({ sessionId: 'acp-session-v1' })
    }
    const { sessionId } = await createTestSession(adapter, spawnMock, handlers)
    expect(sessionId).toBe('acp-session-v1')

    const priv = adapter as unknown as { sessions: Map<string, AcpSessionForTest> }
    const session = priv.sessions.get('acp-session-v1')!
    expect(session.generation).toBe('v1')
    expect(session.capabilities.hasDedicatedSetMode).toBe(true)
  })

  it('detects v2 from the capabilities/info shape even when protocolVersion is misreported', async () => {
    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [] })
    const misreported = { ...v2InitResponse, protocolVersion: 1 }
    const handlers: Record<string, (params: unknown) => unknown> = {
      initialize: () => misreported,
      'session/new': () => ({ sessionId: 'acp-session-v2' })
    }
    const { sessionId } = await createTestSession(adapter, spawnMock, handlers)

    const priv = adapter as unknown as { sessions: Map<string, AcpSessionForTest> }
    const session = priv.sessions.get(sessionId)!
    expect(session.generation).toBe('v2')
    expect(session.capabilities.hasDedicatedSetMode).toBe(false)
    expect(session.capabilities.mcpHttp).toBe(true)
    expect(session.capabilities.promptImage).toBe(true)
  })

  it('uses session/resume (not session/load) to resume a v2 session', async () => {
    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [] })
    const resumeSpy = vi.fn(() => ({}))
    const { proc } = createFakeProcess({ initialize: () => v2InitResponse, 'session/resume': resumeSpy })
    spawnMock.mockReturnValue(proc)

    await adapter.resumeSession('existing-session', { agentId: 'a', taskId: 'existing-session', workspaceDir: '/tmp' } as SessionConfig)
    expect(resumeSpy).toHaveBeenCalled()
  })
})

describe('AcpAgentAdapter - mcpServers passthrough', () => {
  let spawnMock: ReturnType<typeof vi.fn>
  beforeEach(async () => {
    const cp = await import('child_process')
    spawnMock = cp.spawn as unknown as ReturnType<typeof vi.fn>
  })

  it('always forwards stdio servers verbatim', async () => {
    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [] })
    const sessionNewSpy = vi.fn(() => ({ sessionId: 'mcp-1' }))
    const handlers = { initialize: () => v1InitResponse, 'session/new': sessionNewSpy }
    const { proc } = createFakeProcess(handlers)
    spawnMock.mockReturnValue(proc)

    await adapter.createSession({
      agentId: 'a', taskId: 'mcp-task', workspaceDir: '/tmp',
      mcpServers: { local: { type: 'stdio', command: 'node', args: ['server.js'], env: { FOO: 'bar' } } }
    } as SessionConfig)

    expect(sessionNewSpy).toHaveBeenCalledWith({
      cwd: '/tmp',
      mcpServers: [{ name: 'local', command: 'node', args: ['server.js'], env: [{ name: 'FOO', value: 'bar' }] }]
    })
  })

  it('skips an http MCP server when the agent does not advertise http transport support', async () => {
    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [] })
    const sessionNewSpy = vi.fn(() => ({ sessionId: 'mcp-2' }))
    const { proc } = createFakeProcess({ initialize: () => v1InitResponse, 'session/new': sessionNewSpy })
    spawnMock.mockReturnValue(proc)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await adapter.createSession({
      agentId: 'a', taskId: 'mcp-task-2', workspaceDir: '/tmp',
      mcpServers: { remote: { type: 'http', url: 'https://example.com/mcp' } }
    } as SessionConfig)

    expect(sessionNewSpy).toHaveBeenCalledWith({ cwd: '/tmp', mcpServers: [] })
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping MCP server "remote"'))
    warnSpy.mockRestore()
  })

  it('injects an http MCP server when the agent advertises http transport support', async () => {
    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [] })
    const sessionNewSpy = vi.fn(() => ({ sessionId: 'mcp-3' }))
    const { proc } = createFakeProcess({ initialize: () => v2InitResponse, 'session/new': sessionNewSpy })
    spawnMock.mockReturnValue(proc)

    await adapter.createSession({
      agentId: 'a', taskId: 'mcp-task-3', workspaceDir: '/tmp',
      mcpServers: { remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } } }
    } as SessionConfig)

    expect(sessionNewSpy).toHaveBeenCalledWith({
      cwd: '/tmp',
      mcpServers: [{ type: 'http', name: 'remote', url: 'https://example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer x' }] }]
    })
  })
})

describe('AcpAgentAdapter - fs scoping (enableFs)', () => {
  let workspaceDir: string
  beforeEach(() => { workspaceDir = mkdtempSync(join(tmpdir(), 'acp-fs-test-')) })

  it('allows reading and writing a file inside the workspace', async () => {
    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [], enableFs: true })
    const priv = adapterPrivate(adapter) as unknown as {
      handleFsWriteRequest: (session: AcpSessionForTest, request: JsonRpcRequestForTest) => Promise<void>
      handleFsReadRequest: (session: AcpSessionForTest, request: JsonRpcRequestForTest) => Promise<void>
    }
    const session = createMockSession('fs-1')
    session.config.workspaceDir = workspaceDir
    const target = join(workspaceDir, 'note.txt')
    const responses: unknown[] = []
    session.process = { stdin: { write: (data: string) => { responses.push(JSON.parse(data)) } } } as unknown as ChildProcess

    await priv.handleFsWriteRequest(session, { jsonrpc: '2.0', id: 1, method: 'fs/write_text_file', params: { path: target, content: 'hello' } })
    await priv.handleFsReadRequest(session, { jsonrpc: '2.0', id: 2, method: 'fs/read_text_file', params: { path: target } })

    expect(responses[0]).toMatchObject({ result: {} })
    expect(responses[1]).toMatchObject({ result: { content: 'hello' } })
  })

  it('rejects a `../` path escape', async () => {
    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [], enableFs: true })
    const priv = adapterPrivate(adapter) as unknown as {
      handleFsReadRequest: (session: AcpSessionForTest, request: JsonRpcRequestForTest) => Promise<void>
    }
    const session = createMockSession('fs-2')
    session.config.workspaceDir = workspaceDir
    const responses: unknown[] = []
    session.process = { stdin: { write: (data: string) => { responses.push(JSON.parse(data)) } } } as unknown as ChildProcess
    const escapePath = join(workspaceDir, '..', 'escaped.txt')
    writeFileSync(escapePath, 'secret')

    await priv.handleFsReadRequest(session, { jsonrpc: '2.0', id: 1, method: 'fs/read_text_file', params: { path: escapePath } })
    expect(responses[0]).toMatchObject({ error: { code: -32000 } })
  })

  it('rejects a symlink that escapes the workspace', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'acp-fs-outside-'))
    const secretFile = join(outsideDir, 'secret.txt')
    writeFileSync(secretFile, 'top secret')
    const linkPath = join(workspaceDir, 'link.txt')
    symlinkSync(secretFile, linkPath)

    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [], enableFs: true })
    const priv = adapterPrivate(adapter) as unknown as {
      handleFsReadRequest: (session: AcpSessionForTest, request: JsonRpcRequestForTest) => Promise<void>
    }
    const session = createMockSession('fs-3')
    session.config.workspaceDir = workspaceDir
    const responses: unknown[] = []
    session.process = { stdin: { write: (data: string) => { responses.push(JSON.parse(data)) } } } as unknown as ChildProcess

    await priv.handleFsReadRequest(session, { jsonrpc: '2.0', id: 1, method: 'fs/read_text_file', params: { path: linkPath } })
    expect(responses[0]).toMatchObject({ error: { code: -32000 } })
  })

  it('refuses fs requests when enableFs is false', async () => {
    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [] })
    const priv = adapterPrivate(adapter) as unknown as {
      handleFsReadRequest: (session: AcpSessionForTest, request: JsonRpcRequestForTest) => Promise<void>
    }
    const session = createMockSession('fs-4')
    session.config.workspaceDir = workspaceDir
    const responses: unknown[] = []
    session.process = { stdin: { write: (data: string) => { responses.push(JSON.parse(data)) } } } as unknown as ChildProcess

    await priv.handleFsReadRequest(session, { jsonrpc: '2.0', id: 1, method: 'fs/read_text_file', params: { path: join(workspaceDir, 'x.txt') } })
    expect(responses[0]).toMatchObject({ error: { code: -32601 } })
  })
})

describe('AcpAgentAdapter - image content blocks', () => {
  it('includes an image block when promptCapabilities.image is true', () => {
    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [] })
    const priv = adapterPrivate(adapter)
    const session = createMockSession('img-1')
    session.capabilities.promptImage = true

    const blocks = priv.buildPromptContentBlocks(
      [{ type: MessagePartType.IMAGE, content: 'data:image/png;base64,QUJD' } as MessagePart],
      session
    )
    expect(blocks).toEqual([{ type: 'image', data: 'QUJD', mimeType: 'image/png' }])
  })

  it('silently omits an image block when the agent does not advertise image support', () => {
    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [] })
    const priv = adapterPrivate(adapter)
    const session = createMockSession('img-2')
    session.capabilities.promptImage = false

    const blocks = priv.buildPromptContentBlocks(
      [{ type: MessagePartType.IMAGE, content: 'data:image/png;base64,QUJD' } as MessagePart],
      session
    )
    expect(blocks).toEqual([])
  })
})

describe('AcpAgentAdapter - wrapper hook dispatch', () => {
  afterEach(() => { unregisterWrapperHooksForTests('fake-model-agent') })

  it('runs mapModelIdToWire on the model id sent to the agent', async () => {
    registerWrapperHooksForTests('fake-model-agent', { mapModelIdToWire: (id) => `wire-${id}` })
    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [], registryAgentId: 'fake-model-agent' })
    const cp = await import('child_process')
    const spawnMock = cp.spawn as unknown as ReturnType<typeof vi.fn>
    const setConfigSpy = vi.fn(() => ({}))
    const { proc } = createFakeProcess({ initialize: () => v1InitResponse, 'session/new': () => ({ sessionId: 'model-1' }), 'session/set_config_option': setConfigSpy })
    spawnMock.mockReturnValue(proc)

    await adapter.createSession({ agentId: 'a', taskId: 'model-task', workspaceDir: '/tmp', model: 'gpt-5' } as SessionConfig)
    expect(setConfigSpy).toHaveBeenCalledWith({ sessionId: 'model-1', configId: 'model', value: 'wire-gpt-5' })
  })

  it('uses preferredAuthMethod to auto-select an auth method category', () => {
    registerWrapperHooksForTests('fake-model-agent', {
      preferredAuthMethod: ({ availableMethods }) => (availableMethods.includes('env_var') ? 'env_var' : undefined)
    })
    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [], registryAgentId: 'fake-model-agent' })
    const priv = adapter as unknown as { autoSelectAuthMethod: (methods: Array<{ id: string }>) => { id: string } | undefined }
    const chosen = priv.autoSelectAuthMethod([{ id: 'agent' }, { id: 'env_var' }])
    expect(chosen?.id).toBe('env_var')
  })
})

describe('AcpAgentAdapter - lazy process config resolution', () => {
  it('resolves the real command/args/env once, in initialize(), before any spawn', async () => {
    const resolveProcessConfig = vi.fn().mockResolvedValue({ command: 'resolved-agent', args: ['--real'], env: { REAL: '1' } })
    const adapter = new AcpAgentAdapter({ command: '', args: [], resolveProcessConfig })
    await adapter.initialize()

    expect(resolveProcessConfig).toHaveBeenCalledTimes(1)
    const priv = adapter as unknown as { processConfig: { command: string; args: string[]; env?: Record<string, string> } }
    expect(priv.processConfig).toEqual({ command: 'resolved-agent', args: ['--real'], env: { REAL: '1' } })
  })

  it('only resolves once across repeated initialize() calls', async () => {
    const resolveProcessConfig = vi.fn().mockResolvedValue({ command: 'resolved-agent', args: [] })
    const adapter = new AcpAgentAdapter({ command: '', args: [], resolveProcessConfig })
    await adapter.initialize()
    await adapter.initialize()

    expect(resolveProcessConfig).toHaveBeenCalledTimes(1)
  })

  it('propagates a resolution failure (e.g. install error) instead of spawning a placeholder', async () => {
    const resolveProcessConfig = vi.fn().mockRejectedValue(new Error('install failed: checksum mismatch'))
    const adapter = new AcpAgentAdapter({ command: '', args: [], resolveProcessConfig })
    await expect(adapter.initialize()).rejects.toThrow('install failed: checksum mismatch')
  })
})

describe('AcpAgentAdapter - sign-in flow', () => {
  it('terminal auth method returns the command/args/env to run in 20x\'s terminal', async () => {
    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: ['serve'] })
    const priv = adapter as unknown as { sessions: Map<string, AcpSessionForTest> }
    const session = createMockSession('auth-terminal')
    session.lastAuthMethods = [{ id: 'cli-login', name: 'CLI login', type: 'terminal', args: ['login'], env: { FOO: 'bar' } } as never]
    priv.sessions.set('auth-terminal', session)

    const result = await adapter.startSignIn('auth-terminal', 'cli-login')
    expect(result).toEqual({ kind: 'terminal', command: 'fake-agent', args: ['serve', 'login'], env: { FOO: 'bar' } })
  })

  it('env_var auth method exposes the expected env var names without any RPC', async () => {
    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [] })
    const priv = adapter as unknown as { sessions: Map<string, AcpSessionForTest> }
    const session = createMockSession('auth-env')
    session.lastAuthMethods = [{ id: 'env_var', name: 'API key', description: 'Set FAKE_API_KEY' } as never]
    priv.sessions.set('auth-env', session)

    const result = await adapter.startSignIn('auth-env', 'env_var')
    expect(result).toEqual({ kind: 'env_var', envVarNames: ['FAKE_API_KEY'] })
  })

  it('agent auth method calls authenticate directly and resolves once it completes', async () => {
    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [] })
    const priv = adapter as unknown as { sessions: Map<string, AcpSessionForTest>; sendRpcRequest: (s: unknown, m: string, p?: unknown) => Promise<unknown> }
    const session = createMockSession('auth-agent')
    session.lastAuthMethods = [{ id: 'default', name: 'Default' } as never]
    priv.sessions.set('auth-agent', session)
    const spy = vi.spyOn(priv, 'sendRpcRequest').mockResolvedValue({})

    const result = await adapter.startSignIn('auth-agent', 'default')
    expect(result).toEqual({ kind: 'agent', ok: true })
    expect(spy).toHaveBeenCalledWith(session, 'authenticate', { methodId: 'default' })
  })

  it('browser auth method surfaces the elicitation URL without opening it, and waits for explicit confirmation', async () => {
    const adapter = new AcpAgentAdapter({ command: 'fake-agent', args: [] })
    const priv = adapter as unknown as {
      sessions: Map<string, AcpSessionForTest>
      sendRpcRequest: (s: unknown, m: string, p?: unknown) => Promise<unknown>
      handleElicitationCreate: (s: AcpSessionForTest, r: JsonRpcRequestForTest) => void
    }
    const session = createMockSession('auth-browser')
    session.lastAuthMethods = [{ id: 'browser-login', name: 'Browser login' } as never]
    priv.sessions.set('auth-browser', session)
    // authenticate() never resolves on its own in this test — the elicitation drives the result.
    vi.spyOn(priv, 'sendRpcRequest').mockReturnValue(new Promise(() => {}))

    const signInPromise = adapter.startSignIn('auth-browser', 'browser-login')
    // Let the microtask queue settle so pendingAuth placeholder is installed.
    await Promise.resolve()
    priv.handleElicitationCreate(session, { jsonrpc: '2.0', id: 'elicit-1', method: 'elicitation/create', params: { url: 'https://example.com/authorize' } })

    const result = await signInPromise
    expect(result).toEqual({ kind: 'browser', url: 'https://example.com/authorize' })

    const sendResponseSpy = vi.spyOn(priv as unknown as { sendRpcResponse: (...a: unknown[]) => void }, 'sendRpcResponse')
    adapter.confirmElicitation('auth-browser', true)
    expect(sendResponseSpy).toHaveBeenCalledWith(session, 'elicit-1', { result: { action: 'accept' } })
  })
})
