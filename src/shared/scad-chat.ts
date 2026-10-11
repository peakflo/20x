import type { Artifact } from './artifacts'

interface ChatMessageWithFile {
  content: string
  tool?: { status?: string; title?: string; input?: unknown; output?: unknown }
}

/** Find a SCAD file named by a chat message or a finished tool call. */
export function findChatScadArtifact(message: ChatMessageWithFile, artifacts: Artifact[]): Artifact | undefined {
  let text = message.content || ''
  if (message.tool) {
    if (!['success', 'succeeded', 'complete', 'completed'].includes(message.tool.status?.toLowerCase() || '')) return undefined
    text += `\n${message.tool.title || ''}`
    for (const value of [message.tool.input, message.tool.output]) {
      try { text += `\n${typeof value === 'string' ? value : JSON.stringify(value)}` } catch { /* ignore bad tool data */ }
    }
  }
  const normalized = text.replace(/\\/g, '/').toLowerCase()
  return artifacts.find((artifact) => {
    const path = artifact.path?.replace(/\\/g, '/').toLowerCase()
    if (!path?.endsWith('.scad')) return false
    const fileName = path.split('/').pop() || path
    return normalized.includes(path) || normalized.includes(fileName)
  })
}
