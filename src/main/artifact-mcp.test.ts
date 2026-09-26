import { createHash } from 'crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { artifactMcpCounterCount, callArtifactMcp } from './artifact-mcp'
import { readTaskArtifact } from './artifacts'
import { ArtifactContentKind } from '../shared/artifacts'
import type { DatabaseManager } from './database'
import type { McpToolCaller } from './mcp-tool-caller'

vi.mock('./artifacts', () => ({ readTaskArtifact: vi.fn() }))
const html = '<script type="application/json" id="mcp-app-manifest">{"tools":["workflow_list","workflow_execute"]}</script>'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const db = { getTask: () => ({ id: 'task' }), getWorkspaceDir: () => '/tmp/task',
  getMcpServers: () => [{ name: '[Workflo] Organisation Workspace', source: 'enterprise' }] } as unknown as DatabaseManager
const caller = { callTool: vi.fn(async () => ({ success: true, result: { content: [] } })) } as unknown as McpToolCaller

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(readTaskArtifact).mockResolvedValue({ kind: ArtifactContentKind.TEXT, content: html, mimeType: 'text/html' })
})

describe('artifact MCP main-process gate', () => {
  const input = { taskId: 'task', path: 'index.html', name: 'workflow_list', arguments: {},
    contentHash: hash(html), consented: true, approved: false }

  it('rejects a tool absent from the stored file even if the renderer requests it', async () => {
    await expect(callArtifactMcp(db, caller, { ...input, name: 'workflow_get' }, 'desktop'))
      .rejects.toThrow('not declared')
    expect(caller.callTool).not.toHaveBeenCalled()
  })

  it('rejects writes without approval and authoring even if declared', async () => {
    await expect(callArtifactMcp(db, caller, { ...input, name: 'workflow_execute' }, 'desktop'))
      .rejects.toThrow('approval')
    await expect(callArtifactMcp(db, caller, { ...input, name: 'workflow_add_node', approved: true }, 'desktop'))
      .rejects.toThrow('not callable')
    expect(caller.callTool).not.toHaveBeenCalled()
  })

  it('checks the file hash and forwards a permitted read to the named server', async () => {
    await expect(callArtifactMcp(db, caller, { ...input, contentHash: 'stale' }, 'desktop'))
      .rejects.toThrow('not declared')
    await callArtifactMcp(db, caller, input, 'desktop')
    expect(caller.callTool).toHaveBeenCalledWith(expect.objectContaining({ name: '[Workflo] Organisation Workspace' }), 'workflow_list', {})
  })

  it('logs every refusal with a reason and counts it toward the limit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const probe = { ...input, path: 'probe.html', name: 'workflow_get' }
    for (let i = 0; i < 30; i++) {
      await expect(callArtifactMcp(db, caller, probe, 'desktop')).rejects.toThrow('not declared')
    }
    await expect(callArtifactMcp(db, caller, { ...input, path: 'probe.html' }, 'desktop')).rejects.toThrow('limit')
    expect(caller.callTool).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[artifact MCP]', expect.objectContaining({ outcome: 'denied', reason: 'tool-not-declared', tool: 'workflow_get', viewerId: 'desktop' }))
    expect(warn).toHaveBeenLastCalledWith('[artifact MCP]', expect.objectContaining({ outcome: 'denied', reason: 'rate-limit' }))
  })

  it('forgets idle counters from past minutes', async () => {
    const base = (Math.floor(Date.now() / 60_000) + 10_000) * 60_000
    vi.useFakeTimers()
    try {
      vi.setSystemTime(base)
      for (let i = 0; i < 20; i++) await callArtifactMcp(db, caller, { ...input, path: `p${i}.html` }, 'desktop').catch(() => undefined)
      expect(artifactMcpCounterCount()).toBeGreaterThanOrEqual(20)
      vi.setSystemTime(base + 60_000)
      await callArtifactMcp(db, caller, { ...input, path: 'next.html' }, 'desktop').catch(() => undefined)
      expect(artifactMcpCounterCount()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
