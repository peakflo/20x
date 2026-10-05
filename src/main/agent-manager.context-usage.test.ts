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

  it('starts a fresh meter when the agent or harness changes', () => {
    const codex = db.createAgent(makeAgent({ config: { coding_agent: 'codex' } }))!
    const claude = db.createAgent(makeAgent({ config: { coding_agent: 'claude-code' } }))!

    adapterFor(codex.id).onContextUsage?.({ taskId: 'task-1', agentId: codex.id, usedTokens: 90, maxTokens: 100, model: 'gpt-x', canCompact: true })
    adapterFor(claude.id).onContextUsage?.({ taskId: 'task-1', agentId: claude.id, usedTokens: 10 })

    expect(manager.getContextUsage('task-1')).toMatchObject({
      agentId: claude.id,
      codingAgent: 'claude-code',
      usedTokens: 10,
      maxTokens: null,
      percent: null,
      model: null,
      canCompact: false
    })
  })

  it('keeps the window within one agent when reports continue', () => {
    const claude = db.createAgent(makeAgent({ config: { coding_agent: 'claude-code' } }))!
    const adapter = adapterFor(claude.id)
    adapter.onContextUsage?.({ taskId: 'task-1', agentId: claude.id, usedTokens: 10, maxTokens: 200_000 })
    adapter.onContextUsage?.({ taskId: 'task-1', agentId: claude.id, usedTokens: 20 })

    expect(manager.getContextUsage('task-1')).toMatchObject({ usedTokens: 20, maxTokens: 200_000 })
  })

  it('clears compacting when the session leaves the working state, but not while it works', () => {
    const claude = db.createAgent(makeAgent({ config: { coding_agent: 'claude-code' } }))!
    adapterFor(claude.id).onContextUsage?.({ taskId: 'task-1', agentId: claude.id, compacting: true })

    const emit = (manager as unknown as { sendToRenderer(channel: string, data: unknown): void }).sendToRenderer.bind(manager)
    emit('agent:status', { taskId: 'task-1', status: 'working' })
    expect(manager.getContextUsage('task-1')?.compacting).toBe(true)

    emit('agent:status', { taskId: 'task-1', status: 'error' })
    expect(manager.getContextUsage('task-1')?.compacting).toBe(false)
  })

  it('clears the meter on session start, so the next context begins empty', () => {
    const claude = db.createAgent(makeAgent({ config: { coding_agent: 'claude-code' } }))!
    adapterFor(claude.id).onContextUsage?.({ taskId: 'task-1', agentId: claude.id, usedTokens: 150_000, maxTokens: 200_000, compacting: true })

    ;(manager as unknown as { clearContextUsage(taskId: string): void }).clearContextUsage('task-1')

    expect(manager.getContextUsage('task-1')).toMatchObject({ usedTokens: null, maxTokens: null, percent: null, compacting: false })
    expect(contextEvents().at(-1)).toMatchObject({ taskId: 'task-1', usedTokens: null })
  })

  it('sends /compact to a compact-capable harness as the bare command', async () => {
    const claude = db.createAgent(makeAgent({ config: { coding_agent: 'claude-code' } }))!
    const task = db.createTask(makeTask())!
    const sendPrompt = vi.fn(async () => {})
    const session = {
      sessionId: 'sess-1', agentId: claude.id, taskId: task.id, workspaceDir: '/tmp', status: 'idle',
      adapter: { sendPrompt, getStatus: vi.fn() }, seenMessageIds: new Set(), seenPartIds: new Set(), partContentLengths: new Map()
    } as any
    const send = (manager as unknown as { doSendAdapterMessage(s: unknown, id: string, m: string): Promise<void> }).doSendAdapterMessage.bind(manager)

    await send(session, 'sess-1', '/compact')

    expect(sendPrompt).toHaveBeenCalledWith('sess-1', [expect.objectContaining({ text: '/compact' })], expect.anything())
    expect(sent.some((e) => e.channel === 'agent:output' && JSON.stringify(e.data).includes('"role":"user"'))).toBe(false)
  })

  it('sends /compact to other harnesses as an ordinary user message', async () => {
    const opencode = db.createAgent(makeAgent({ config: { coding_agent: 'opencode' } }))!
    const task = db.createTask(makeTask())!
    const sendPrompt = vi.fn(async (_sessionId: string, _parts: Array<{ text?: string }>, _config: unknown) => {})
    const session = {
      sessionId: 'sess-2', agentId: opencode.id, taskId: task.id, workspaceDir: '/tmp', status: 'idle',
      adapter: { sendPrompt, getStatus: vi.fn() }, seenMessageIds: new Set(), seenPartIds: new Set(), partContentLengths: new Map()
    } as any
    const send = (manager as unknown as { doSendAdapterMessage(s: unknown, id: string, m: string): Promise<void> }).doSendAdapterMessage.bind(manager)

    await send(session, 'sess-2', '/compact')

    expect(sent.some((e) => e.channel === 'agent:output' && JSON.stringify(e.data).includes('"role":"user"'))).toBe(true)
    expect(sendPrompt.mock.calls[0]?.[1]?.[0]?.text).not.toBe('/compact')
  })
})
