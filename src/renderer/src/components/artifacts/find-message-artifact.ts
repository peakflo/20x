import { pullRequestUrlFromTool, type Artifact } from '@shared/artifacts'

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

function normalizeTarget(value: string): string {
  return value.replace(/\\/g, '/')
}

/**
 * True when `haystack` contains `target` as a complete token — not as a
 * numeric prefix of a longer id (…/pull/997 must not match …/pull/9977,
 * and `#997` must not match `#9977`).
 */
export function containsArtifactTarget(haystack: string, target: string): boolean {
  if (!target) return false
  const normalizedHaystack = normalizeTarget(haystack)
  const normalizedTarget = normalizeTarget(target)
  let from = 0
  while (from <= normalizedHaystack.length) {
    const index = normalizedHaystack.indexOf(normalizedTarget, from)
    if (index === -1) return false
    const after = index + normalizedTarget.length
    const next = normalizedHaystack[after]
    // Targets that end in a digit need a digit boundary so a shorter PR/issue
    // number cannot win inside a longer one (997 vs 9977, 1058 vs 10585).
    if (/\d$/.test(normalizedTarget) && next !== undefined && /\d/.test(next)) {
      from = index + 1
      continue
    }
    return true
  }
  return false
}

function artifactTarget(artifact: Artifact): string | undefined {
  return artifact.path || artifact.url || undefined
}

/** Match a completed tool-call message to the artifact it produced, by
 * substring correlation on the tool's title/input/output — there is no
 * explicit artifact-id-to-tool-call link today. Shared by desktop
 * (AgentTranscriptPanel) and mobile (MessageBubble) so both platforms render
 * the same tool call the same way.
 *
 * When several artifacts match, the longest target wins so a shorter numeric
 * prefix (PR #997) cannot steal a longer reference (PR #9977). */
export function findMessageArtifact(message: ArtifactLookupMessage, artifacts: Artifact[]): Artifact | undefined {
  if (!message.tool || !['success', 'succeeded', 'complete', 'completed'].includes(message.tool.status?.toLowerCase?.() || '')) return undefined

  const extractedPrUrl = pullRequestUrlFromTool(message.tool)
  if (extractedPrUrl) {
    const exact = artifacts.find((artifact) => artifact.url === extractedPrUrl)
    if (exact) return exact
  }

  let haystack = `${message.tool.title || ''}\n${message.content || ''}`
  try {
    haystack += `\n${typeof message.tool.input === 'string' ? message.tool.input : JSON.stringify(message.tool.input)}\n${typeof message.tool.output === 'string' ? message.tool.output : JSON.stringify(message.tool.output)}`
  } catch { /* ignore unserializable tool payloads */ }

  let best: Artifact | undefined
  let bestLength = -1
  for (const artifact of artifacts) {
    const target = artifactTarget(artifact)
    if (!target) continue
    if (!containsArtifactTarget(haystack, target)) continue
    if (target.length > bestLength) {
      best = artifact
      bestLength = target.length
    }
  }
  return best
}
