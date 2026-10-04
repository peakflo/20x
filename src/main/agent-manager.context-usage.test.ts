import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('child_process', () => ({ spawn: vi.fn() }))
vi.mock('./adapters/opencode-adapter', () => ({ OpencodeAdapter: vi.fn() }))
vi.mock('./adapters/acp-adapter', () => ({ AcpAdapter: vi.fn() }))
vi.mock('./adapters/pi-adapter', () => ({ PiAdapter: vi.fn() }))
vi.mock('./adapters/claude-code-adapter', () => ({ ClaudeCodeAdapter: vi.fn() }))
vi.mock('./adapters/codex-app-server-adapter', () => ({ CodexAppServerAdapter: vi.fn() }))
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
import { AGENT_CONTEXT_USAGE_CHANNEL } from '../shared/context-usage'

let db: DatabaseManager
let manager: AgentManager
let sent: Array<{ channel: string; data: unknown }>

function adapterFor(agentId: string): CodingAgentAdapter {
  return (manager as unknown as { getAdapter(id: string): CodingAgentAdapter }).getAdapter(agentId)
}

function contextEvents() {
  return sent.filter((e) => e.channel === AGENT_CONTEXT_USAGE_CHANNEL).map((e) => e.data as Record<string, unknown>)
}

beforeEach(() => {
  ;({ db } = createTestDb())
  manager = new AgentManager(db)
  sent = []
  manager.addExternalListener((channel, data) => sent.push({ channel, data }))
})

describe('AgentManager context usage', () => {
  it('merges partial adapter reports per task and broadcasts the snapshot', () => {
    const agent = db.createAgent(makeAgent({ config: { coding_agent: 'claude-code' } }))!
    const adapter = adapterFor(agent.id)

    adapter.onContextUsage?.({ taskId: 'task-1', agentId: agent.id, providerSessionId: 's1', usedTokens: 50_000, maxTokens: 200_000, model: 'claude-sonnet-4-6', canCompact: true })
    adapter.onContextUsage?.({ taskId: 'task-1', agentId: agent.id, compacting: true })

    const snapshot = manager.getContextUsage('task-1')
    expect(snapshot).toMatchObject({
      taskId: 'task-1',
      agentId: agent.id,
      codingAgent: 'claude-code',
      usedTokens: 50_000,
      maxTokens: 200_000,
      percent: 25,
      model: 'claude-sonnet-4-6',
      compacting: true,
      canCompact: true
    })
    expect(contextEvents().map((e) => [e.usedTokens, e.compacting])).toEqual([[50_000, false], [50_000, true]])
  })

  it('skips broadcasts when nothing the meter shows has changed', () => {
    const agent = db.createAgent(makeAgent({ config: { coding_agent: 'codex' } }))!
    const adapter = adapterFor(agent.id)

    adapter.onContextUsage?.({ taskId: 'task-1', agentId: agent.id, usedTokens: 10, maxTokens: 100 })
    adapter.onContextUsage?.({ taskId: 'task-1', agentId: agent.id, usedTokens: 10, maxTokens: 100, compacting: false })

    expect(contextEvents()).toHaveLength(1)
  })

  it('ignores reports without a task id and returns null for unknown tasks', () => {
    const agent = db.createAgent(makeAgent({ config: { coding_agent: 'codex' } }))!
    adapterFor(agent.id).onContextUsage?.({ usedTokens: 10, maxTokens: 100 })

    expect(contextEvents()).toEqual([])
    expect(manager.getContextUsage('task-1')).toBeNull()
  })

  it('sends the auto-compact threshold to the session config, normalized and off by default', async () => {
    const off = db.createAgent(makeAgent({ config: { coding_agent: 'claude-code' } }))!
    const on = db.createAgent(makeAgent({ config: { coding_agent: 'claude-code', auto_compact_tokens: 412_345 } }))!
    const task = db.createTask(makeTask())!
    const build = (agentId: string) => (manager as unknown as {
      buildSessionConfig(agentId: string, taskId: string, dir?: string): Promise<{ autoCompactTokens?: number | null }>
    }).buildSessionConfig(agentId, task.id, '/tmp')

    expect((await build(off.id)).autoCompactTokens).toBeNull()
    expect((await build(on.id)).autoCompactTokens).toBe(412_000)
  })

  it('stores auto_compact_tokens in its bounded form', () => {
    const agent = db.createAgent(makeAgent({ config: { coding_agent: 'claude-code', auto_compact_tokens: 5_000_000 } }))!
    expect(agent.config.auto_compact_tokens).toBe(1_000_000)

    const updated = db.updateAgent(agent.id, { config: { coding_agent: 'claude-code', auto_compact_tokens: 10 } })!
    expect(updated.config.auto_compact_tokens).toBe(100_000)
  })
})
