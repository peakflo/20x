/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn(), AbortError: class AbortError extends Error {} }))
vi.mock('child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, existsSync: vi.fn(() => false) }
})

import { ClaudeCodeAdapter } from './claude-code-adapter'
import { CodexAppServerAdapter } from './codex-app-server-adapter'
import { SessionStatusType } from './coding-agent-adapter'

function claudeSetup(messages: unknown[]) {
  const adapter = new ClaudeCodeAdapter()
  const queue = [...messages]
  const session: any = {
    sessionId: 's1',
    queryIterator: {
      [Symbol.asyncIterator]() { return this },
      async next() {
        const value = queue.shift()
        return value === undefined ? { done: true, value: undefined } : { done: false, value }
      }
    },
    status: 'busy', messageBuffer: [], messageCursor: 0, lastError: null,
    config: { taskId: 't1', agentId: 'a1', workspaceDir: '/w' },
    backgroundTasks: new Map(), sawResult: false, enqueuePrompt: null, releasePrompt: null
  }
  ;(adapter as any).sessions.set('s1', session)
  return { adapter, session }
}

const rejected = (type: string, resetsAt?: number) => ({
  type: 'rate_limit_event', uuid: `rl-${type}`, session_id: 's1',
  rate_limit_info: { status: 'rejected', rateLimitType: type, utilization: 1, ...(resetsAt ? { resetsAt } : {}) }
})

describe('Claude usage-limit stops', () => {
  it('flags a blocking_limit turn with the latest reset among rejected windows', async () => {
    const { adapter, session } = claudeSetup([
      rejected('five_hour', 1_791_200_000),
      rejected('seven_day_opus', 1_791_300_000),
      { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'blocking_limit', result: "You've hit your limit", uuid: 'r1' }
    ])
    await (adapter as any).consumeStream('s1', session)
    const status = await adapter.getStatus('s1', {} as any)
    expect(status).toEqual({
      type: SessionStatusType.ERROR,
      message: "You've hit your limit",
      usageLimit: { resetAt: new Date(1_791_300_000 * 1000).toISOString() }
    })
  })

  it('reports an unknown reset when a rejected window has no reset time', async () => {
    const { adapter, session } = claudeSetup([
      rejected('five_hour', 1_791_200_000),
      rejected('seven_day'),
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['rate limited'], uuid: 'r1' }
    ])
    await (adapter as any).consumeStream('s1', session)
    expect((await adapter.getStatus('s1', {} as any)).usageLimit).toEqual({ resetAt: null })
  })

  it('does not flag ordinary errors, and windows that recover are dropped', async () => {
    const { adapter, session } = claudeSetup([
      rejected('five_hour', 1_791_200_000),
      { type: 'rate_limit_event', uuid: 'ok', session_id: 's1', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.2 } },
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['tool crashed'], uuid: 'r1' }
    ])
    await (adapter as any).consumeStream('s1', session)
    const status = await adapter.getStatus('s1', {} as any)
    expect(status.type).toBe(SessionStatusType.ERROR)
    expect(status.usageLimit).toBeUndefined()
  })
})

describe('Codex usage-limit stops', () => {
  function codexSetup() {
    const adapter = new CodexAppServerAdapter()
    const priv = adapter as any
    const session: any = {
      sessionId: 't', threadId: 'thread-1', activeTurnId: 'turn-1',
      process: { stdin: { write: vi.fn() }, exitCode: null, signalCode: null },
      status: SessionStatusType.BUSY, messageBuffer: [], permanentMessages: [], bufferedThreadItemIds: new Set(),
      pendingCompletionRefreshes: 0, sawThreadStatusNotification: false, pendingThreadIdle: false,
      pendingRequests: new Map(), pendingApproval: null, nextRequestId: 1, lastError: null,
      config: { taskId: 't1', agentId: 'a1', model: 'gpt' }, streamedTextByItemId: new Map(), assistantTextKeysByTurn: new Map(),
      runningTools: new Map(), codexUseApiKey: false, codexAuthSummary: '', createdInApp: true, pendingUsage: null
    }
    priv.sessions.set('thread-1', session)
    vi.spyOn(priv, 'sendRpcRequest').mockResolvedValue({
      rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_791_200_000 }, secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1_791_600_000 } }
    })
    return { adapter, priv, session }
  }

  const limitError = {
    jsonrpc: '2.0', method: 'error',
    params: { threadId: 'thread-1', turnId: 'turn-1', willRetry: false, error: { message: "You've hit your usage limit", codexErrorInfo: 'usageLimitExceeded' } }
  }

  it('classifies usageLimitExceeded and fills the reset time from the exhausted window', async () => {
    const { adapter, priv, session } = codexSetup()
    priv.handleRpcMessage(session, limitError)
    expect(session.usageLimit).toEqual({ resetAt: null })
    // The adapter reads the plan windows right away to learn the reset time.
    await new Promise((resolve) => setImmediate(resolve))
    const status = await adapter.getStatus('thread-1', {} as any)
    expect(status.usageLimit).toEqual({ resetAt: new Date(1_791_200_000 * 1000).toISOString() })
  })

  it('uses already-known windows immediately and ignores other error codes', async () => {
    const { priv, session } = codexSetup()
    priv.handleRpcMessage(session, {
      jsonrpc: '2.0', method: 'account/rateLimits/updated',
      params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_791_250_000 } } }
    })
    priv.handleRpcMessage(session, limitError)
    expect(session.usageLimit).toEqual({ resetAt: new Date(1_791_250_000 * 1000).toISOString() })

    const other = codexSetup()
    other.priv.handleRpcMessage(other.session, { ...limitError, params: { ...limitError.params, error: { message: 'boom', codexErrorInfo: 'internalServerError' } } })
    expect(other.session.usageLimit).toBeUndefined()
  })
})
