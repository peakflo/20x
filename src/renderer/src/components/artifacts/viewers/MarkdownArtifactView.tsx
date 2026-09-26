import { Markdown } from '@/components/ui/Markdown'
import type { Artifact, ArtifactApi } from '@shared/artifacts'
import { ArtifactContentKind } from '@shared/artifacts'
import { ArtifactViewState } from './ArtifactViewState'
import { useArtifactContent } from './use-artifact-content'
import { useCallback } from 'react'
import { isLocalArtifactLink } from '@shared/artifact-navigation'
import { readArtifactResource } from '../artifact-resources'

export function MarkdownArtifactView({ artifact, artifactApi, refreshTrigger = 0, onLinkClick }: { artifact: Artifact; artifactApi: ArtifactApi; refreshTrigger?: number; onLinkClick?: (href: string) => boolean }) {
  const state = useArtifactContent(artifact, artifactApi, refreshTrigger)
  const text = state.content?.kind === ArtifactContentKind.TEXT ? state.content.content : null
  const files = artifact.files || (artifact.path ? [artifact.path] : [])
  const filesKey = files.join('\0')
  const loadImage = useCallback((src: string) => isLocalArtifactLink(src)
    ? readArtifactResource(artifact.path || '', src, files, (path) => artifactApi.read(artifact.taskId, path))
    : Promise.resolve(src), [artifact.path, artifact.taskId, artifactApi, filesKey])
  return <ArtifactViewState loading={state.loading} error={state.error} missing={text === null}><div className="h-full overflow-y-auto px-6 py-5"><Markdown size="sm" onLinkClick={onLinkClick} loadImage={loadImage}>{text || ''}</Markdown></div></ArtifactViewState>
}
