import { createHash } from 'crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callArtifactMcp } from './artifact-mcp'
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
})
