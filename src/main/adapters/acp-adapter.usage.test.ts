/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest'

vi.mock('child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }))
vi.mock('../usage/cursor-limits', () => ({
  probeCursorUsageLimits: vi.fn(async ({ allowKeychain }: { allowKeychain: boolean }) => ({
    provider: 'cursor',
    checkedAt: '2026-10-05T10:00:00.000Z',
    windows: allowKeychain ? [{ id: 'total', kind: 'monthly', label: 'Monthly · Overall', usedPercent: 50 }] : [],
    unavailable: null
  }))
}))

import { AcpAdapter } from './acp-adapter'
import { probeCursorUsageLimits } from '../usage/cursor-limits'
import { SessionStatusType, type AdapterCumulativeUsageReport } from './coding-agent-adapter'

function session(): any {
  return {
    sessionId: 'acp-1',
    acpSessionId: 'acp-1',
    createdInApp: true,
    usageCostUsd: null,
    status: SessionStatusType.BUSY,
    messageBuffer: [],
    permanentMessages: [],
    pendingRequests: new Map(),
    promptRequestId: 7,
    activeTurnId: 1,
    config: { taskId: 'task-1', agentId: 'agent-1', model: 'gpt-5', workspaceDir: '/w' }
  }
}

describe('AcpAdapter (Cursor) usage tracking', () => {
  it('reports prompt usage with the cumulative cost from usage_update', () => {
    const adapter = new AcpAdapter('cursor')
    const priv = adapter as any
    const reports: AdapterCumulativeUsageReport[] = []
    adapter.onUsage = (report) => reports.push(report as AdapterCumulativeUsageReport)
    const s = session()

    priv.handleRpcMessage(s, {
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: 'acp-1', update: { sessionUpdate: 'usage_update', used: 30_000, size: 200_000, cost: { amount: 0.8, currency: 'USD' } } }
    })
    expect(s.messageBuffer).toEqual([]) // bookkeeping, not transcript

    priv.handleRpcMessage(s, {
      jsonrpc: '2.0', id: 7,
      result: { stopReason: 'end_turn', usage: { totalTokens: 11_000, inputTokens: 1_000, outputTokens: 600, cachedReadTokens: 9_400 } }
    })

    expect(s.status).toBe(SessionStatusType.IDLE)
    expect(reports).toEqual([{
      provider: 'cursor',
      providerSessionId: 'acp-1',
      taskId: 'task-1',
      agentId: 'agent-1',
      newSession: true,
      buckets: [{
        key: 'session',
        model: 'gpt-5',
        totals: { inputTokens: 1_000, cacheReadTokens: 9_400, cacheWriteTokens: 0, outputTokens: 600, reasoningTokens: 0, costUsd: 0.8 }
      }]
    }])
  })

  it('does not report usage for other ACP agents', () => {
    const adapter = new AcpAdapter('codex')
    const onUsage = vi.fn()
    adapter.onUsage = onUsage
    ;(adapter as any).handleRpcMessage(session(), { jsonrpc: '2.0', id: 7, result: { stopReason: 'end_turn', usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 } } })
    expect(onUsage).not.toHaveBeenCalled()
  })

  it('probes Cursor plan limits with the user Keychain consent', async () => {
    const adapter = new AcpAdapter('cursor')
    expect((await adapter.probeUsageLimits())?.windows).toEqual([])
    adapter.cursorKeychainAccess = () => true
    expect((await adapter.probeUsageLimits())?.windows).toHaveLength(1)
    expect(vi.mocked(probeCursorUsageLimits)).toHaveBeenLastCalledWith({ allowKeychain: true })
    expect(await new AcpAdapter('codex').probeUsageLimits()).toBeNull()
  })
})
