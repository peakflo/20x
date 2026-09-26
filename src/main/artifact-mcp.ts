import { createHash } from 'crypto'
import type { DatabaseManager } from './database'
import type { McpToolCaller } from './mcp-tool-caller'
import { readTaskArtifact } from './artifacts'
import { ArtifactContentKind } from '../shared/artifacts'
import { artifactManifestAllows, artifactToolsFromHtml, isArtifactCallableTool, isArtifactWriteTool, type ArtifactMcpCall } from '../shared/artifact-mcp'

const counters = new Map<string, { minute: number; total: number; writes: number; active: number }>()

/** The main process re-reads the file. Renderer declarations are never authority. */
export async function callArtifactMcp(
  db: DatabaseManager,
  caller: McpToolCaller,
  input: ArtifactMcpCall,
  viewerId: string
): Promise<unknown> {
  if (!db.getTask(input.taskId)) throw new Error('Task not found')
  if (!isArtifactCallableTool(input.name)) throw new Error('Tool is not callable from an artifact')
  if (!input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments) ||
      JSON.stringify(input.arguments).length > 65536) throw new Error('Invalid arguments')
  const content = await readTaskArtifact(db.getWorkspaceDir(input.taskId), input.path)
  if (!content || content.kind !== ArtifactContentKind.TEXT || content.mimeType !== 'text/html') {
    throw new Error('HTML artifact not found')
  }
  const contentHash = createHash('sha256').update(content.content).digest('hex')
  if (input.contentHash !== contentHash ||
      !artifactManifestAllows(artifactToolsFromHtml(content.content), input.name)) {
    throw new Error('Tool is not declared in stored artifact')
  }
  if (!input.consented || (isArtifactWriteTool(input.name) && !input.approved)) {
    throw new Error('Viewer approval required')
  }
  const server = db.getMcpServers().find((item) => item.name === '[Workflo] Organisation Workspace' && item.source === 'enterprise')
  if (!server) throw new Error('Organisation Workspace is not connected')
  const key = `${viewerId}:${input.taskId}:${input.path}`
  const minute = Math.floor(Date.now() / 60000)
  const counter = counters.get(key) ?? { minute, total: 0, writes: 0, active: 0 }
  if (counter.minute !== minute) Object.assign(counter, { minute, total: 0, writes: 0 })
  const write = isArtifactWriteTool(input.name)
  if (counter.total >= 30 || (write && counter.writes >= 5) || counter.active >= 3) {
    throw new Error('Artifact call limit reached')
  }
  counter.total++
  if (write) counter.writes++
  counter.active++
  counters.set(key, counter)
  const audit = { source: 'artifact', artifactId: `${input.taskId}:${input.path}`, contentHash, viewerId, consented: input.consented, tool: input.name }
  try {
    const result = await caller.callTool(server, input.name, input.arguments)
    if (!result.success) throw new Error(result.error ?? 'Tool call failed')
    console.info('[artifact MCP]', { ...audit, outcome: 'completed' })
    return result.result
  } catch (error) {
    console.error('[artifact MCP]', { ...audit, outcome: 'failed', error })
    throw error
  } finally {
    counter.active--
  }
}
