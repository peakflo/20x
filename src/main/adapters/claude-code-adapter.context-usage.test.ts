/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  AbortError: class AbortError extends Error {}
}))
vi.mock('child_process', () => ({ execFile: vi.fn() }))
vi.mock('fs', () => ({ existsSync: vi.fn(() => false) }))

import { ClaudeCodeAdapter, claudeAutoCompactOptions } from './claude-code-adapter'
import type { AdapterContextUsageReport } from '../../shared/context-usage'

function fakeQuery(messages: unknown[]) {
  const queue = [...messages]
  return {
    [Symbol.asyncIterator]() { return this },
    async next() {
      const value = queue.shift()
      return value === undefined ? { done: true, value: undefined } : { done: false, value }
    }
  }
}

function setup(messages: unknown[]) {
  const adapter = new ClaudeCodeAdapter()
  const session: any = {
    sessionId: 'claude-session-1',
    queryIterator: fakeQuery(messages),
    abortController: null,
    status: 'busy',
    messageBuffer: [],
    messageCursor: 0,
    streamTask: null,
    lastError: null,
    config: { taskId: 'task-1', agentId: 'agent-1', workspaceDir: '/tmp' },
    createdInApp: true,
    backgroundTasks: new Map(),
    sawResult: false,
    enqueuePrompt: null,
    releasePrompt: null
  }
  ;(adapter as any).sessions.set('claude-session-1', session)
  const reports: AdapterContextUsageReport[] = []
  adapter.onContextUsage = (report) => reports.push(report)
  return { adapter, session, reports }
}

function assistant(model: string, usage: Record<string, number>, parent: string | null = null) {
  return {
    type: 'assistant',
    parent_tool_use_id: parent,
    session_id: 'claude-session-1',
    uuid: `a-${Math.random()}`,
    message: { model, role: 'assistant', content: [], usage }
  }
}

const result = (modelUsage: Record<string, unknown>) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: 'claude-session-1',
  uuid: 'r1',
  modelUsage
})

describe('ClaudeCodeAdapter context usage', () => {
  it('reports main-loop context size and skips subagent messages', async () => {
    const { adapter, session, reports } = setup([
      assistant('claude-opus-4-7[1m]', { input_tokens: 5, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 100, output_tokens: 50 }),
      assistant('claude-haiku-4-5', { input_tokens: 9, output_tokens: 9 }, 'toolu_1')
    ])
    await (adapter as any).consumeStream('claude-session-1', session)

    expect(reports).toEqual([{
      taskId: 'task-1',
      agentId: 'agent-1',
      providerSessionId: 'claude-session-1',
      canCompact: true,
      usedTokens: 1_155,
      maxTokens: 1_000_000,
      model: 'claude-opus-4-7[1m]'
    }])
  })

  it('learns the window from result.modelUsage for later turns', async () => {
    const { adapter, session, reports } = setup([
      assistant('claude-opus-4-7', { input_tokens: 10, output_tokens: 10 }),
      result({ 'claude-opus-4-7': { contextWindow: 300_000 } }),
      assistant('claude-opus-4-7', { input_tokens: 20, output_tokens: 10 })
    ])
    await (adapter as any).consumeStream('claude-session-1', session)

    const resultReport = reports.find((r) => r.usedTokens === undefined && r.maxTokens !== undefined)
    expect(resultReport).toMatchObject({ maxTokens: 300_000, model: 'claude-opus-4-7' })
    expect(reports[reports.length - 1]).toMatchObject({ usedTokens: 30, maxTokens: 300_000 })
  })

  it('reports the post-compaction size and clears the compacting flag at the boundary', async () => {
    const { adapter, session, reports } = setup([
      { type: 'system', subtype: 'status', status: 'compacting', session_id: 'claude-session-1', uuid: 's1' },
      { type: 'system', subtype: 'compact_boundary', session_id: 'claude-session-1', uuid: 's2', compact_metadata: { trigger: 'manual', pre_tokens: 180_000, post_tokens: 12_000 } },
      { type: 'system', subtype: 'status', status: null, session_id: 'claude-session-1', uuid: 's3' }
    ])
    await (adapter as any).consumeStream('claude-session-1', session)

    expect(reports).toEqual([
      expect.objectContaining({ compacting: true, canCompact: true }),
      expect.objectContaining({ usedTokens: 12_000, compacting: false }),
      expect.objectContaining({ compacting: false })
    ])
    expect(reports[1].maxTokens).toBeUndefined()
  })
})

describe('claudeAutoCompactOptions', () => {
  it('passes the threshold as settings.autoCompactWindow', () => {
    expect(claudeAutoCompactOptions(400_000)).toEqual({ settings: { autoCompactWindow: 400_000 } })
  })

  it('leaves the harness default when auto-compact is off or invalid', () => {
    expect(claudeAutoCompactOptions(null)).toEqual({})
    expect(claudeAutoCompactOptions(undefined)).toEqual({})
    expect(claudeAutoCompactOptions(Number.NaN)).toEqual({})
    expect(claudeAutoCompactOptions(0)).toEqual({})
  })
})
