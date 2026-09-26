import { createHash } from 'crypto'
import type { DatabaseManager } from './database'
import type { McpToolCaller } from './mcp-tool-caller'
import { readTaskArtifact } from './artifacts'
import { ArtifactContentKind } from '../shared/artifacts'
import { artifactManifestAllows, artifactToolsFromHtml, isArtifactCallableTool, isArtifactWriteTool, type ArtifactMcpCall } from '../shared/artifact-mcp'

const LIMITS = { total: 30, writes: 5, active: 3 }
const counters = new Map<string, { minute: number; total: number; writes: number; active: number }>()
let lastSweepMinute = Number.NEGATIVE_INFINITY

/** Test seam. */
export function artifactMcpCounterCount(): number {
  return counters.size
}

/** Delete idle counters from a past minute, once per minute, so the map
 * holds at most about one minute of keys. */
function sweep(minute: number): void {
  if (minute === lastSweepMinute) return
  lastSweepMinute = minute
  for (const [key, counter] of counters) {
    if (counter.minute < minute && counter.active === 0) counters.delete(key)
  }
}

class ArtifactMcpDenied extends Error {}

/**
 * The main process re-reads the file. Renderer declarations are never authority.
 *
 * EVERY ATTEMPT counts toward the limit BEFORE the other checks, and every
 * refusal is logged with its reason, so probing leaves a trail and is
 * throttled. `consented` and `approved` are logged as what the host claimed.
 */
export async function callArtifactMcp(
  db: DatabaseManager,
  caller: McpToolCaller,
  input: ArtifactMcpCall,
  viewerId: string
): Promise<unknown> {
  const name = typeof input?.name === 'string' ? input.name.slice(0, 200) : null
  const audit: Record<string, unknown> = {
    source: 'artifact',
    artifactId: `${input?.taskId}:${input?.path}`,
    viewerId,
    tool: name,
    write: name ? isArtifactWriteTool(name) : false,
    consented: input?.consented === true,
    approved: input?.approved === true
  }
  const deny = (reason: string, message: string): never => {
    console.warn('[artifact MCP]', { ...audit, outcome: 'denied', reason })
    throw new ArtifactMcpDenied(message)
  }
  const minute = Math.floor(Date.now() / 60000)
  sweep(minute)
  const key = `${viewerId}:${input?.taskId}:${input?.path}`
  const counter = counters.get(key) ?? { minute, total: 0, writes: 0, active: 0 }
  counters.set(key, counter)
  if (counter.minute !== minute) Object.assign(counter, { minute, total: 0, writes: 0 })
  if (counter.total >= LIMITS.total || counter.active >= LIMITS.active) {
    deny('rate-limit', 'Artifact call limit reached')
  }
  counter.total++
  counter.active++
  try {
    if (!name || !isArtifactCallableTool(name)) deny('tool-not-callable', 'Tool is not callable from an artifact')
    const toolName = name as string
    if (!db.getTask(input.taskId)) deny('task-not-found', 'Task not found')
    if (!input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments) ||
        JSON.stringify(input.arguments).length > 65536) deny('invalid-arguments', 'Invalid arguments')
    const content = await readTaskArtifact(db.getWorkspaceDir(input.taskId), input.path)
    if (!content || content.kind !== ArtifactContentKind.TEXT || content.mimeType !== 'text/html') {
      deny('no-html', 'HTML artifact not found')
    }
    const html = (content as { content: string }).content
    const contentHash = createHash('sha256').update(html).digest('hex')
    audit.contentHash = contentHash
    if (input.contentHash !== contentHash) deny('content-hash-mismatch', 'Tool is not declared in stored artifact')
    if (!artifactManifestAllows(artifactToolsFromHtml(html), toolName)) {
      deny('tool-not-declared', 'Tool is not declared in stored artifact')
    }
    const write = isArtifactWriteTool(toolName)
    if (!input.consented || (write && !input.approved)) deny('approval-missing', 'Viewer approval required')
    const server = db.getMcpServers().find((item) => item.name === '[Workflo] Organisation Workspace' && item.source === 'enterprise')
    if (!server) deny('workspace-not-connected', 'Organisation Workspace is not connected')
    // The arguments may hold tenant data, so the log keeps a hash only.
    audit.argumentsHash = createHash('sha256').update(JSON.stringify(input.arguments)).digest('hex')
    if (write) {
      if (counter.writes >= LIMITS.writes) deny('write-rate-limit', 'Artifact call limit reached')
      counter.writes++
    }
    try {
      const result = await caller.callTool(server!, toolName, input.arguments)
      if (!result.success) throw new Error(result.error ?? 'Tool call failed')
      console.info('[artifact MCP]', { ...audit, outcome: 'completed' })
      return result.result
    } catch (error) {
      console.error('[artifact MCP]', { ...audit, outcome: 'failed', error })
      throw error
    }
  } finally {
    counter.active--
  }
}
