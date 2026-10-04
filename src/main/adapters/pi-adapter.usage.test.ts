/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest'

vi.mock('child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }))
vi.mock('../enterprise-ai-gateway', () => ({
  ENTERPRISE_AI_GATEWAY_PROVIDER_ID: 'peakflo',
  ENTERPRISE_AI_GATEWAY_PROVIDER_NAME: 'Peakflo',
  buildPiAiGatewayProviderConfig: vi.fn(() => ({})),
  readEnterpriseAiGatewayConfig: vi.fn(() => null)
}))

import { PiAdapter } from './pi-adapter'
import type { AdapterCumulativeUsageReport } from './coding-agent-adapter'

function session(createdInApp: boolean): any {
  return {
    id: '/sessions/s1.jsonl',
    config: { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/w', model: 'anthropic/claude-opus-4-7' },
    status: 'busy',
    pendingUiRequests: new Map(),
    pendingTurnError: null,
    parts: [],
    textByBlock: new Map(),
    reasoningByBlock: new Map(),
    toolParts: new Map(),
    createdInApp,
    lastModel: null
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('PiAdapter usage tracking', () => {
  it('reports cumulative session stats when a turn settles, attributed to the last model', async () => {
    const adapter = new PiAdapter({ getSetting: vi.fn(() => null) } as any)
    const priv = adapter as any
    const reports: AdapterCumulativeUsageReport[] = []
    adapter.onUsage = (report) => reports.push(report as AdapterCumulativeUsageReport)
    const command = vi.spyOn(priv, 'command').mockResolvedValue({
      type: 'response', command: 'get_session_stats', success: true,
      data: { tokens: { input: 500, output: 80, cacheRead: 4_000, cacheWrite: 300, total: 4_880 }, cost: 0.09 }
    })
    vi.spyOn(priv, 'reconcileAssistantMessage').mockImplementation(() => undefined)
    const s = session(true)

    priv.handleEvent(s, { type: 'message_end', message: { role: 'assistant', provider: 'openai', model: 'gpt-5', stopReason: 'stop' } })
    priv.handleEvent(s, { type: 'agent_settled' })
    await flush()

    expect(command).toHaveBeenCalledWith(s, { type: 'get_session_stats' })
    expect(reports).toEqual([{
      provider: 'pi',
      providerSessionId: '/sessions/s1.jsonl',
      taskId: 'task-1',
      agentId: 'agent-1',
      newSession: true,
      buckets: [{
        key: 'session',
        model: 'openai/gpt-5',
        totals: { inputTokens: 500, cacheReadTokens: 4_000, cacheWriteTokens: 300, outputTokens: 80, reasoningTokens: 0, costUsd: 0.09 }
      }]
    }])
  })

  it('does nothing when usage tracking is not wired', async () => {
    const adapter = new PiAdapter({ getSetting: vi.fn(() => null) } as any)
    const command = vi.spyOn(adapter as any, 'command')
    ;(adapter as any).handleEvent(session(false), { type: 'agent_settled' })
    await flush()
    expect(command).not.toHaveBeenCalled()
  })
})
