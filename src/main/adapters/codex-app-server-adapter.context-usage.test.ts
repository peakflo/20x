/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest'
import { CodexAppServerAdapter } from './codex-app-server-adapter'
import { SessionStatusType, type AdapterUsageLimitsEvent, type AdapterCumulativeUsageReport as AdapterUsageReport } from './coding-agent-adapter'
import type { AdapterContextUsageReport } from '../../shared/context-usage'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn((_cmd, _args, callback) => callback(null, '/usr/local/bin/codex\n', ''))
}))

interface AdapterPrivate {
  sessions: Map<string, any>
  handleRpcMessage(session: any, message: unknown): void
  sendRpcRequest(session: any, method: string, params?: unknown): Promise<unknown>
}

function createSession(overrides: Record<string, unknown> = {}) {
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
    config: { taskId: 'task-1', agentId: 'agent-1', model: 'gpt-6-astra', workspaceDir: '/tmp' },
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

function setup(session = createSession()) {
  const adapter = new CodexAppServerAdapter()
  const priv = adapter as unknown as AdapterPrivate
  priv.sessions.set('thread-1', session)
  vi.spyOn(priv, 'sendRpcRequest').mockResolvedValue({})
  const contextReports: AdapterContextUsageReport[] = []
  const usageReports: AdapterUsageReport[] = []
  const limitEvents: AdapterUsageLimitsEvent[] = []
  adapter.onContextUsage = (report) => contextReports.push(report)
  adapter.onUsage = (report) => usageReports.push(report as AdapterUsageReport)
  adapter.onUsageLimits = (event) => limitEvents.push(event)
  return { adapter, priv, session, contextReports, usageReports }
}

describe('CodexAppServerAdapter context usage', () => {
  it('reports the last model call size and the model window on thread/tokenUsage/updated', () => {
    const { priv, session, contextReports } = setup()
    priv.handleRpcMessage(session, {
      jsonrpc: '2.0',
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          total: { inputTokens: 9_000, cachedInputTokens: 0, outputTokens: 500, reasoningOutputTokens: 0, totalTokens: 9_500 },
          last: { inputTokens: 4_000, cachedInputTokens: 0, outputTokens: 300, reasoningOutputTokens: 0, totalTokens: 4_300 },
          modelContextWindow: 272_000
        }
      }
    })

    expect(contextReports).toEqual([{
      taskId: 'task-1',
      agentId: 'agent-1',
      providerSessionId: 'thread-1',
      canCompact: true,
      usedTokens: 4_300,
      maxTokens: 272_000,
      model: 'gpt-6-astra'
    }])
  })

  it('sends /compact as thread/compact/start without a user item or turn/start', async () => {
    const { adapter, priv, session, contextReports } = setup()

    await adapter.sendPrompt('thread-1', [{ type: 'text', text: ' /compact ' } as any], session.config as any)

    expect(priv.sendRpcRequest).toHaveBeenCalledTimes(1)
    expect(priv.sendRpcRequest).toHaveBeenCalledWith(session, 'thread/compact/start', { threadId: 'thread-1' })
    expect(priv.sendRpcRequest).not.toHaveBeenCalledWith(session, 'turn/start', expect.anything())
    expect(session.messageBuffer).toEqual([])
    expect(contextReports).toEqual([expect.objectContaining({ compacting: true, canCompact: true })])
  })

  it('clears the compacting flag on thread/compacted and on a contextCompaction item', () => {
    const { priv, session, contextReports } = setup()
    priv.handleRpcMessage(session, { jsonrpc: '2.0', method: 'thread/compacted', params: { threadId: 'thread-1' } })
    priv.handleRpcMessage(session, {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'c1', type: 'contextCompaction' } }
    })

    expect(contextReports).toEqual([
      expect.objectContaining({ compacting: false }),
      expect.objectContaining({ compacting: false })
    ])
  })

  it('clears the compacting flag when the compact request fails', async () => {
    const { adapter, priv, session, contextReports } = setup()
    vi.mocked(priv.sendRpcRequest).mockRejectedValueOnce(new Error('boom'))

    await expect(adapter.sendPrompt('thread-1', [{ type: 'text', text: '/compact' } as any], session.config as any)).rejects.toThrow('boom')
    expect(contextReports.map((r) => r.compacting)).toEqual([true, false])
  })
})
