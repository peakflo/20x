import type { Artifact } from '@shared/artifacts'

/** A minimal shape covering both the desktop `AgentMessage` and the mobile
 * `AgentMessage` — they are defined separately per platform store but carry
 * the same tool-call fields this needs. */
export interface ArtifactLookupMessage {
  tool?: {
    status?: string
    title?: string
    input?: unknown
    output?: unknown
  }
  content?: string
}

/** Match a completed tool-call message to the artifact it produced, by
 * substring correlation on the tool's title/input/output — there is no
 * explicit artifact-id-to-tool-call link today. Shared by desktop
 * (AgentTranscriptPanel) and mobile (MessageBubble) so both platforms render
 * the same tool call the same way. */
export function findMessageArtifact(message: ArtifactLookupMessage, artifacts: Artifact[]): Artifact | undefined {
  if (!message.tool || !['success', 'succeeded', 'complete', 'completed'].includes(message.tool.status?.toLowerCase?.() || '')) return undefined
  let haystack = `${message.tool.title || ''}\n${message.content || ''}`
  try { haystack += `\n${typeof message.tool.input === 'string' ? message.tool.input : JSON.stringify(message.tool.input)}\n${typeof message.tool.output === 'string' ? message.tool.output : JSON.stringify(message.tool.output)}` } catch { /* ignore unserializable tool payloads */ }
  return artifacts.find((artifact) => {
    const target = artifact.path || artifact.url
    return !!target && (haystack.includes(target) || haystack.replace(/\\/g, '/').includes(target.replace(/\\/g, '/')))
  })
}
