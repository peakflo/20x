/**
 * Bridge between Spaces artifacts and 20x's existing artifact IPC.
 *
 * A Spaces artifact is addressed by a `spaces:<session>:<artifact>` path, so the
 * existing viewers read it through the same `artifacts:read` call as a local
 * file. Content comes from the runner service (cache plus live fetch). Spaces
 * artifacts are read-only: every write-like artifact call refuses them here, in
 * the main process, whatever the UI shows.
 */

import { ArtifactContentKind, type ArtifactContent } from '../../shared/artifacts'
import { isSpacesArtifactId, type SpacesArtifactContent } from '../../shared/enterprise-runners'

export const SPACES_ARTIFACT_READ_ONLY = 'Spaces artifacts are read-only. Open it in Spaces to change it.'

export class SpacesArtifactReadOnlyError extends Error {
  constructor() {
    super(SPACES_ARTIFACT_READ_ONLY)
    this.name = 'SpacesArtifactReadOnlyError'
  }
}

export function isSpacesArtifactPath(path: unknown): path is string {
  return typeof path === 'string' && isSpacesArtifactId(path)
}

/** Throws for a Spaces artifact; a no-op for everything else. */
export function assertNotSpacesArtifact(path: unknown): void {
  if (isSpacesArtifactPath(path)) throw new SpacesArtifactReadOnlyError()
}

type SpacesReader = (taskId: string, id: string) => Promise<SpacesArtifactContent>
let reader: SpacesReader | null = null

/** Set by main once the runner runtime exists; null while signed out. */
export function setSpacesArtifactReader(next: SpacesReader | null): void {
  reader = next
}

/** Turns service content into what the existing viewers expect. */
export function toArtifactContent(content: SpacesArtifactContent): ArtifactContent {
  if (content.content === null || content.encoding === 'none') {
    throw new Error(content.availability === 'not-cached'
      ? 'This Spaces artifact is not available offline. Reconnect, or open it in Spaces.'
      : 'This Spaces artifact has no previewable content. Open it in Spaces.')
  }
  if (content.encoding === 'base64') {
    return { kind: ArtifactContentKind.DATA_URL, content: `data:${content.mimeType};base64,${content.content}`, mimeType: content.mimeType }
  }
  return { kind: ArtifactContentKind.TEXT, content: content.content, mimeType: content.mimeType }
}

export async function readSpacesArtifact(taskId: string, path: string): Promise<ArtifactContent> {
  if (!reader) throw new Error('Sign in to Peakflo Enterprise to read Spaces artifacts.')
  return toArtifactContent(await reader(taskId, path))
}
