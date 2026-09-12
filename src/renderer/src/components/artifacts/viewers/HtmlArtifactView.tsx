import type { Artifact, ArtifactApi } from '@shared/artifacts'
import { ArtifactContentKind } from '@shared/artifacts'
import { ArtifactViewState } from './ArtifactViewState'
import { useArtifactContent } from './use-artifact-content'
import { ArtifactHtmlFrame } from './ArtifactHtmlFrame'

export function HtmlArtifactView({ artifact, artifactApi, onMessage, onLinkClick, refreshTrigger = 0 }: { artifact: Artifact; artifactApi: ArtifactApi; onMessage?: (data: unknown) => void; onLinkClick?: (href: string) => boolean; refreshTrigger?: number }) {
  const state = useArtifactContent(artifact, artifactApi, refreshTrigger)
  const html = state.content?.kind === ArtifactContentKind.TEXT ? state.content.content : null
  return <ArtifactViewState loading={state.loading} error={state.error} missing={html === null}><ArtifactHtmlFrame key={`${artifact.path}:${artifact.reloadTrigger}`} html={html || ''} title={artifact.title} onLinkClick={onLinkClick} onMessage={onMessage} /></ArtifactViewState>
}
