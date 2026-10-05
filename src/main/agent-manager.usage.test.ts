import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('child_process', () => ({ spawn: vi.fn() }))
vi.mock('./adapters/opencode-adapter', () => ({ OpencodeAdapter: vi.fn() }))
vi.mock('./adapters/acp-adapter', () => ({ AcpAdapter: vi.fn() }))
vi.mock('./adapters/pi-adapter', () => ({ PiAdapter: vi.fn() }))
vi.mock('./adapters/claude-code-adapter', () => ({
  ClaudeCodeAdapter: vi.fn(function (this: Record<string, unknown>) {
    this.probeUsageLimits = vi.fn(async () => ({
      provider: 'claude-code',
      checkedAt: '2026-10-05T10:00:00.000Z',
      planType: 'max',
      windows: [{ id: 'five_hour', kind: 'session', label: '5-hour', usedPercent: 20 }],
      unavailable: null
    }))
  })
}))
vi.mock('./adapters/codex-app-server-adapter', () => ({
  CodexAppServerAdapter: vi.fn(function (this: Record<string, unknown>) {
    this.probeUsageLimits = vi.fn(async () => null)
  })
}))
vi.mock('./task-api-server', () => ({ getTaskApiPort: vi.fn(), waitForTaskApiServer: vi.fn() }))
vi.mock('./secret-broker', () => ({
  registerSecretSession: vi.fn(),
  unregisterSecretSession: vi.fn(),
  getSecretBrokerPort: vi.fn(),
  writeSecretShellWrapper: vi.fn()
}))

import { AgentManager } from './agent-manager'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeAgent, makeTask } from '../../test/helpers/task-fixtures'
import type { DatabaseManager } from './database'
import type { CodingAgentAdapter } from './adapters/coding-agent-adapter'
import { USAGE_LIMITS_UPDATED_CHANNEL, USAGE_RECORDED_CHANNEL } from '../shared/usage'

let db: DatabaseManager
let manager: AgentManager
let sent: Array<{ channel: string; data: unknown }>

function adapterFor(agentId: string): CodingAgentAdapter {
  return (manager as unknown as { getAdapter(id: string): CodingAgentAdapter }).getAdapter(agentId)
}

beforeEach(() => {
  ;({ db } = createTestDb())
  manager = new AgentManager(db)
  sent = []
  manager.addExternalListener((channel, data) => sent.push({ channel, data }))
})

describe('AgentManager usage tracking', () => {
  it('records adapter usage reports and broadcasts them', () => {
    const agent = db.createAgent(makeAgent({ config: { coding_agent: 'codex' } }))!
    const adapter = adapterFor(agent.id)

    adapter.onUsage?.({
      provider: 'codex',
      providerSessionId: 'thread-1',
      taskId: 'task-1',
      agentId: agent.id,
      newSession: true,
      buckets: [{ key: 'thread', model: 'gpt-6-astra', totals: { inputTokens: 100, cacheReadTokens: 400, cacheWriteTokens: 0, outputTokens: 30, reasoningTokens: 10, costUsd: null } }]
    })

    const recorded = sent.find((e) => e.channel === USAGE_RECORDED_CHANNEL)
    expect(recorded?.data).toEqual([expect.objectContaining({ provider: 'codex', taskId: 'task-1', inputTokens: 100, outputTokens: 30 })])

    const summary = manager.getUsageSummary({ sinceMs: 0 })
    expect(summary?.totals).toMatchObject({ inputTokens: 100, cacheReadTokens: 400, outputTokens: 30, records: 1 })
  })

  it('applies streamed plan-limit updates and broadcasts the merged snapshot', () => {
    const agent = db.createAgent(makeAgent({ config: { coding_agent: 'claude-code' } }))!
    const adapter = adapterFor(agent.id)

    adapter.onUsageLimits?.({
      kind: 'update',
      provider: 'claude-code',
      update: { windows: [{ id: 'seven_day', kind: 'weekly', label: 'Weekly', usedPercent: 66 }] }
    })

    expect(manager.getUsageLimits()).toEqual([
      expect.objectContaining({ provider: 'claude-code', windows: [expect.objectContaining({ id: 'seven_day', usedPercent: 66 })] })
    ])
    expect(sent.some((e) => e.channel === USAGE_LIMITS_UPDATED_CHANNEL)).toBe(true)
  })

  it('probes plan limits only for providers with subscription agents', async () => {
    db.createAgent(makeAgent({ config: { coding_agent: 'claude-code' } }))
    db.createAgent(makeAgent({ config: { coding_agent: 'codex', auth_method: 'api_key' } }))

    const result = await manager.refreshUsageLimits({ force: true })

    expect(result.refreshed).toEqual(['claude-code'])
    expect(result.limits).toEqual([expect.objectContaining({ provider: 'claude-code', planType: 'max' })])
  })
})

describe('AgentManager triage prompt', () => {
  it('asks the triage agent to prefer harnesses with plan-limit headroom only among equally suitable agents', () => {
    const task = db.createTask(makeTask({ title: 'Fix login' }))!
    const prompt = (manager as unknown as { buildTriagePrompt(task: unknown): string }).buildTriagePrompt(task)
    expect(prompt).toContain('`usage_limits`')
    expect(prompt).toContain('Fit comes first')
    expect(prompt).toMatch(/Among agents that fit equally well, prefer the one whose `usage_limits` shows the lowest usage/)
    expect(prompt).toContain('fit first, then the lowest current plan usage among equally suitable agents')
  })
})
