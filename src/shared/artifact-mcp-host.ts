import { artifactManifestAllows, artifactToolsFromHtml, isArtifactCallableTool, isArtifactWriteTool, type ArtifactMcpCall } from './artifact-mcp'

const consents = new Set<string>()
const sessionWrites = new Set<string>()

export async function handleArtifactMcpMessage(
  html: string,
  target: { taskId: string; path: string },
  data: unknown,
  reply: (message: Record<string, unknown>) => void,
  call: (input: ArtifactMcpCall) => Promise<unknown>
): Promise<void> {
  if (!data || typeof data !== 'object') return
  const request = data as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
  if (request.jsonrpc !== '2.0' || (typeof request.id !== 'number' && typeof request.id !== 'string')) return
  const send = (value: { result?: unknown; error?: unknown }): void => reply({ jsonrpc: '2.0', id: request.id, ...value })
  const deny = (code: number, message: string): void => send({ error: { code, message } })
  if (request.method === 'ui/initialize') {
    send({ result: { protocolVersion: '2026-01-26', hostInfo: { name: '20x-artifact-host', version: '1.0.0' }, hostCapabilities: { serverTools: {} }, hostContext: {} } })
    return
  }
  if (request.method !== 'tools/call') { deny(-32601, 'Method not found'); return }
  const params = request.params as { name?: unknown; arguments?: unknown } | null
  const name = params?.name
  const args = params?.arguments ?? {}
  if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args) || JSON.stringify(args).length > 65536) {
    deny(-32602, 'Invalid tool call'); return
  }
  const declared = artifactToolsFromHtml(html)
  if (!isArtifactCallableTool(name) || !artifactManifestAllows(declared, name)) {
    deny(-32001, 'Tool is not declared'); return
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(html))
  const contentHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  const key = `${target.taskId}:${target.path}:${contentHash}`
  if (!consents.has(key)) {
    if (!window.confirm(`This artifact wants to read workspace tools with your access:\n${declared.join(', ')}\n\nAllow for this page?`)) {
      deny(-32002, 'Viewer denied access'); return
    }
    consents.add(key)
  }
  const write = isArtifactWriteTool(name)
  if (write && !sessionWrites.has(key)) {
    if (!window.confirm(`Run ${name} with your access?\n\n${JSON.stringify(args, null, 2)}`)) {
      deny(-32002, 'Viewer denied this call'); return
    }
    if (window.confirm('Allow more runs from this artifact for this page session?')) sessionWrites.add(key)
  }
  try {
    const result = await call({ ...target, name, arguments: args as Record<string, unknown>, contentHash, consented: true, approved: write })
    send({ result })
  } catch (error) {
    deny(-32002, error instanceof Error ? error.message : 'Tool call failed')
  }
}
