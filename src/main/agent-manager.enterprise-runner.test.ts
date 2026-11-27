/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest'
import { AgentManager } from './agent-manager'

function manager(agents: Record<string, any>, choice: 'local' | 'runner') {
  const m = Object.create(AgentManager.prototype) as any
  m.db = { getAgent: (id: string) => agents[id] }
  m.adapters = new Map()
  m.wireUsageTracking = vi.fn()
  m.resolveAgentInstance = vi.fn(() => null)
  const runnerAdapter = { kind: 'runner' }
  m.enterpriseRunnerRuntime = {
    createAdapter: vi.fn(() => runnerAdapter),
    service: { getTaskRunOn: () => ({ choice: choice === 'runner' ? { kind: 'runner', runnerId: 'r', runnerName: 'x' } : { kind: 'local' }, locked: false }) }
  }
  return { m, runnerAdapter }
}

const synced = { id: 'synced', config: { coding_agent: 'claude-code', enterprise_agent_id: 'srv-1' } }
const runnerOnly = { id: 'ronly', config: { coding_agent: 'enterprise-runner', enterprise_agent_id: 'srv-2' } }
const localAgent = { id: 'local', config: { coding_agent: 'claude-code' } }

describe('where a task runs follows its Run on choice', () => {
  it('a synced agent runs on the runner when the task chose a runner, and locally on This Mac', () => {
    expect(manager({ synced }, 'runner').m.runsOnRunner('synced', 't1')).toBe(true)
    expect(manager({ synced }, 'local').m.runsOnRunner('synced', 't1')).toBe(false)
  })

  it('a runner-only agent always runs on a runner, even if the stored choice is This Mac', () => {
    expect(manager({ ronly: runnerOnly }, 'local').m.runsOnRunner('ronly', 't1')).toBe(true)
  })

  it('an agent without a Spaces counterpart never runs on a runner', () => {
    expect(manager({ local: localAgent }, 'runner').m.runsOnRunner('local', 't1')).toBe(false)
  })

  it('getAdapter returns the runner adapter only for runner tasks', () => {
    const a = manager({ synced }, 'runner')
    expect(a.m.getAdapter('synced', 't1')).toBe(a.runnerAdapter)
    expect(a.m.getAdapter('synced')).not.toBe(a.runnerAdapter) // no task: the agent's own harness
  })

  it('the idle reaper skips runner sessions', async () => {
    const a = manager({ synced }, 'runner')
    a.m.sessions = new Map([['s1', { agentId: 'synced', taskId: 't1', status: 'idle', lastActivityAt: 0, createdAt: new Date(0) }]])
    a.m.db.getTask = () => ({ session_id: 's1' })
    a.m.stopSession = vi.fn()
    await a.m.reapInactiveSessions()
    expect(a.m.stopSession).not.toHaveBeenCalled()
  })
})
