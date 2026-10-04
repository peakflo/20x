/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest'
import { OpencodeAdapter } from './opencode-adapter'
import type { AdapterUsageReport } from './coding-agent-adapter'

function assistant(id: string, sessionID: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sessionID,
    role: 'assistant',
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4-5',
    time: { created: Date.now(), completed: Date.now() },
    cost: 0.05,
    tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 100, write: 0 } },
    ...overrides
  }
}

function setup() {
  const adapter = new OpencodeAdapter()
  const priv = adapter as any
  const reports: AdapterUsageReport[] = []
  adapter.onUsage = (report) => reports.push(report)
  priv.usageSessions.set('ses_root', { taskId: 'task-1', agentId: 'agent-1', trackSinceMs: 0 })
  const event = (type: string, info: unknown) => priv.handleServerEvent({ payload: { type, properties: { info } } })
  return { adapter, priv, reports, event }
}

describe('OpencodeAdapter usage tracking', () => {
  it('reports completed assistant messages of tracked sessions', () => {
    const { reports, event } = setup()
    event('message.updated', assistant('m1', 'ses_root', { time: { created: Date.now() } })) // still streaming
    event('message.updated', assistant('m1', 'ses_root'))
    event('message.updated', assistant('m9', 'ses_other')) // not ours

    expect(reports).toEqual([{
      kind: 'discrete',
      provider: 'opencode',
      providerSessionId: 'ses_root',
      taskId: 'task-1',
      agentId: 'agent-1',
      items: [expect.objectContaining({
        sourceKey: 'ses_root:m1',
        model: 'anthropic/claude-sonnet-4-5',
        usage: expect.objectContaining({ inputTokens: 10, cacheReadTokens: 100, outputTokens: 25, reasoningTokens: 5, costUsd: 0.05 })
      })]
    }])
  })

  it('attributes subagent (child session) usage to the parent task', () => {
    const { reports, event } = setup()
    event('session.created', { id: 'ses_child', parentID: 'ses_root' })
    event('message.updated', assistant('c1', 'ses_child'))
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ providerSessionId: 'ses_root', taskId: 'task-1' })
  })

  it('ignores history from before a resume', () => {
    const { priv, reports, event } = setup()
    priv.usageSessions.set('ses_root', { taskId: 'task-1', agentId: 'agent-1', trackSinceMs: Date.now() })
    event('message.updated', assistant('old', 'ses_root', { time: { created: Date.now() - 60_000, completed: Date.now() - 50_000 } }))
    event('message.updated', assistant('new', 'ses_root'))
    expect(reports.map((r) => (r as any).items[0].sourceKey)).toEqual(['ses_root:new'])
  })

  it('still handles permission events', () => {
    const { priv } = setup()
    priv.sessionPermissionModes.set('ses_root', 'ask')
    priv.handleServerEvent({ payload: { type: 'permission.asked', properties: { id: 'perm-1', sessionID: 'ses_root', permission: 'bash', patterns: [] } } })
    expect(priv.pendingPermissions.get('ses_root')).toHaveLength(1)
  })

  it('reads OpenCode Go plan limits only when a Go key exists', async () => {
    const { adapter, priv } = setup()
    vi.spyOn(priv, 'readGoApiKey').mockReturnValue(null)
    expect(await adapter.probeUsageLimits()).toBeNull()

    priv.readGoApiKey.mockReturnValue('go-key')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      usage: { rolling: { percent: 30, resetsAt: '2026-10-05T14:00:00Z' } }
    }), { status: 200 }))
    const limits = await adapter.probeUsageLimits()
    expect(fetchSpy).toHaveBeenCalledWith('https://opencode.ai/zen/go/v1/usage', expect.objectContaining({ headers: { Authorization: 'Bearer go-key' } }))
    expect(limits?.windows).toEqual([expect.objectContaining({ id: 'go_rolling', usedPercent: 30 })])

    fetchSpy.mockResolvedValue(new Response('{}', { status: 403 }))
    expect(await adapter.probeUsageLimits()).toBeNull()
    fetchSpy.mockRestore()
  })
})
