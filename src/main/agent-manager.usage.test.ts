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
import { LIMIT_RECOVERY_CONTINUE_MESSAGE, USAGE_LIMIT_RECOVERY_UPDATED_CHANNEL } from '../shared/usage-limit-recovery'

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
    expect(prompt).toContain('API-key login billed per token')
  })
})

describe('AgentManager usage-limit recovery', () => {
  it('records a usage-limit stop and continues the task after the reset', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-05T12:00:00Z'))
    try {
      const agent = db.createAgent(makeAgent({ config: { coding_agent: 'claude-code' } }))!
      const task = db.createTask(makeTask({ title: 'Long job' }))!
      db.updateTask(task.id, { agent_id: agent.id })
      const send = vi.spyOn(manager, 'sendByTaskId').mockResolvedValue({ sessionId: 's1' })
      const priv = manager as unknown as {
        recordUsageLimitStop(taskId: string, agentId: string, sessionId: string, resetAt: string | null, message?: string): void
        getLimitRecovery(): { sweep(): Promise<void> }
      }

      priv.recordUsageLimitStop(task.id, agent.id, 's1', '2026-10-05T14:00:00Z', "You've hit your limit")
      expect(manager.getUsageLimitRecovery(task.id)).toMatchObject({ status: 'waiting', provider: 'claude-code', autoResume: true })
      expect(sent.some((e) => e.channel === USAGE_LIMIT_RECOVERY_UPDATED_CHANNEL)).toBe(true)

      await priv.getLimitRecovery().sweep()
      expect(send).not.toHaveBeenCalled()

      vi.setSystemTime(new Date('2026-10-05T14:05:00Z'))
      await priv.getLimitRecovery().sweep()
      expect(send).toHaveBeenCalledWith(task.id, LIMIT_RECOVERY_CONTINUE_MESSAGE)
      expect(manager.getUsageLimitRecovery(task.id)?.status).toBe('resumed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('honours the auto-resume setting and the per-task toggle', () => {
    const agent = db.createAgent(makeAgent({ config: { coding_agent: 'codex' } }))!
    const task = db.createTask(makeTask())!
    db.updateTask(task.id, { agent_id: agent.id })
    db.setSetting('usage.autoResumeLimitedTasks', 'false')
    const priv = manager as unknown as { recordUsageLimitStop(...args: unknown[]): void }
    priv.recordUsageLimitStop(task.id, agent.id, 'thr', new Date(Date.now() + 3_600_000).toISOString(), 'limit')
    expect(manager.getUsageLimitRecovery(task.id)?.autoResume).toBe(false)
    expect(manager.setUsageLimitRecoveryAutoResume(task.id, true)?.autoResume).toBe(true)
  })
})

describe('AgentManager usage-limit recovery: user activity', () => {
  it('only user activity supersedes a scheduled continuation', () => {
    const agent = db.createAgent(makeAgent({ config: { coding_agent: 'claude-code' } }))!
    const task = db.createTask(makeTask())!
    db.updateTask(task.id, { agent_id: agent.id })
    const priv = manager as unknown as {
      recordUsageLimitStop(...args: unknown[]): void
      limitRecoveryDispatching: Set<string>
    }
    priv.recordUsageLimitStop(task.id, agent.id, 's1', new Date(Date.now() + 3_600_000).toISOString(), 'limit')

    // A continuation being dispatched by the scheduler itself is not user activity.
    priv.limitRecoveryDispatching.add(task.id)
    manager.noteUserTaskActivity(task.id)
    expect(manager.getUsageLimitRecovery(task.id)?.status).toBe('waiting')
    priv.limitRecoveryDispatching.delete(task.id)

    manager.noteUserTaskActivity(task.id)
    expect(manager.getUsageLimitRecovery(task.id)?.status).toBe('superseded')
  })
})
