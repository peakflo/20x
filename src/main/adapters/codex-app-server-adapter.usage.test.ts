import { describe, it, expect, vi } from 'vitest'
import { CodexAppServerAdapter } from './codex-app-server-adapter'
import { SessionStatusType, type AdapterUsageLimitsEvent, type AdapterCumulativeUsageReport as AdapterUsageReport } from './coding-agent-adapter'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn((_cmd, _args, callback) => callback(null, '/usr/local/bin/codex\n', ''))
}))

interface SessionForTest {
  sessionId: string
  threadId: string | null
  activeTurnId: string | null
  process: { stdin: { write: ReturnType<typeof vi.fn> }; exitCode: number | null; signalCode: string | null }
  stdoutBuffer: string
  status: SessionStatusType
  messageBuffer: unknown[]
  permanentMessages: unknown[]
  bufferedThreadItemIds: Set<string>
  pendingCompletionRefreshes: number
  sawThreadStatusNotification: boolean
  pendingThreadIdle: boolean
  pendingRequests: Map<string | number, unknown>
  pendingApproval: unknown | null
  nextRequestId: number
  lastError: string | null
  config: { taskId?: string; agentId?: string; model?: string }
  streamedTextByItemId: Map<string, string>
  assistantTextKeysByTurn: Map<string, Set<string>>
  runningTools: Map<string, unknown>
  codexUseApiKey: boolean
  codexAuthSummary: string
  createdInApp: boolean
  pendingUsage: unknown
}

interface AdapterPrivate {
  sessions: Map<string, SessionForTest>
  handleRpcMessage(session: SessionForTest, message: unknown): void
  sendRpcRequest(session: SessionForTest, method: string, params?: unknown): Promise<unknown>
}

function createSession(overrides: Partial<SessionForTest> = {}): SessionForTest {
  return {
    sessionId: 'task-1',
    threadId: 'thread-1',
    activeTurnId: null,
    process: { stdin: { write: vi.fn() }, exitCode: null, signalCode: null },
    stdoutBuffer: '',
    status: SessionStatusType.IDLE,
    messageBuffer: [],
    permanentMessages: [],
    bufferedThreadItemIds: new Set(),
    pendingCompletionRefreshes: 0,
    sawThreadStatusNotification: false,
    pendingThreadIdle: false,
    pendingRequests: new Map(),
    pendingApproval: null,
    nextRequestId: 1,
    lastError: null,
    config: { taskId: 'task-1', agentId: 'agent-1', model: 'gpt-6-astra' },
    streamedTextByItemId: new Map(),
    assistantTextKeysByTurn: new Map(),
    runningTools: new Map(),
    codexUseApiKey: false,
    codexAuthSummary: '',
    createdInApp: true,
    pendingUsage: null,
    ...overrides
  }
}

function tokenUsage(inputTokens: number, cachedInputTokens: number, outputTokens: number) {
  return {
    jsonrpc: '2.0',
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      tokenUsage: {
        total: { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens: 0, totalTokens: inputTokens + outputTokens },
        last: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
        modelContextWindow: 272_000
      }
    }
  }
}

function setup(session = createSession()) {
  const adapter = new CodexAppServerAdapter()
  const priv = adapter as unknown as AdapterPrivate
  priv.sessions.set('thread-1', session)
  // turn/completed triggers a reconcile that lists thread turns/items.
  vi.spyOn(priv, 'sendRpcRequest').mockResolvedValue({ data: [] })
  const reports: AdapterUsageReport[] = []
  const limitEvents: AdapterUsageLimitsEvent[] = []
  adapter.onUsage = (report) => reports.push(report as AdapterUsageReport)
  adapter.onUsageLimits = (event) => limitEvents.push(event)
  return { adapter, priv, session, reports, limitEvents }
}

describe('CodexAppServerAdapter usage tracking', () => {
  it('reports the latest cumulative thread usage once per turn', () => {
    const { priv, session, reports } = setup(createSession({ activeTurnId: 'turn-1', status: SessionStatusType.BUSY }))

    priv.handleRpcMessage(session, tokenUsage(1_000, 600, 50))
    priv.handleRpcMessage(session, tokenUsage(2_500, 1_800, 120))
    expect(reports).toEqual([])

    priv.handleRpcMessage(session, {
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } }
    })

    expect(reports).toEqual([
      {
        provider: 'codex',
        providerSessionId: 'thread-1',
        taskId: 'task-1',
        agentId: 'agent-1',
        newSession: true,
        buckets: [{
          key: 'thread',
          model: 'gpt-6-astra',
          totals: {
            inputTokens: 700,
            cacheReadTokens: 1_800,
            cacheWriteTokens: 0,
            outputTokens: 120,
            reasoningTokens: 0,
            costUsd: null
          }
        }]
      }
    ])
    // Bookkeeping notifications never reach the transcript buffer.
    expect(session.messageBuffer.some((e) => (e as { method?: string }).method === 'thread/tokenUsage/updated')).toBe(false)
  })

  it('reports usage seen outside a turn immediately (e.g. totals replayed on resume)', () => {
    const { priv, session, reports } = setup(createSession({ createdInApp: false }))
    priv.handleRpcMessage(session, tokenUsage(10, 0, 5))
    expect(reports).toHaveLength(1)
    expect(reports[0].newSession).toBe(false)
  })

  it('forwards rolling rate-limit updates for subscription sessions only', () => {
    const update = {
      jsonrpc: '2.0',
      method: 'account/rateLimits/updated',
      params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 42, windowDurationMins: 300 } } }
    }
    const subscription = setup()
    subscription.priv.handleRpcMessage(subscription.session, update)
    expect(subscription.limitEvents).toEqual([
      {
        kind: 'update',
        provider: 'codex',
        update: { windows: [{ id: 'primary', kind: 'session', label: '5-hour', usedPercent: 42, resetsAt: null, windowDurationMins: 300 }] }
      }
    ])

    const apiKey = setup(createSession({ codexUseApiKey: true }))
    apiKey.priv.handleRpcMessage(apiKey.session, update)
    expect(apiKey.limitEvents).toEqual([])
  })

  it('probes plan limits through a live subscription session', async () => {
    const { adapter, priv } = setup()
    vi.mocked(priv.sendRpcRequest).mockResolvedValue({
      rateLimits: {
        limitId: 'codex',
        planType: 'plus',
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_791_200_000 },
        secondary: { usedPercent: 30, windowDurationMins: 10_080, resetsAt: 1_791_600_000 }
      }
    })

    const limits = await adapter.probeUsageLimits()

    expect(priv.sendRpcRequest).toHaveBeenCalledWith(expect.anything(), 'account/rateLimits/read', null)
    expect(limits).toMatchObject({
      provider: 'codex',
      planType: 'plus',
      unavailable: null,
      windows: [
        { id: 'primary', usedPercent: 12 },
        { id: 'secondary', usedPercent: 30 }
      ]
    })
  })

  it('returns a probe_failed snapshot when the read fails', async () => {
    const { adapter, priv } = setup()
    vi.mocked(priv.sendRpcRequest).mockRejectedValue(new Error('Codex app-server RPC timed out: account/rateLimits/read'))
    const limits = await adapter.probeUsageLimits()
    expect(limits?.unavailable).toEqual({
      reason: 'probe_failed',
      message: 'Codex app-server RPC timed out: account/rateLimits/read'
    })
  })
})
