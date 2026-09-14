import { Markdown } from '@/components/ui/Markdown'
import type { Artifact, ArtifactApi } from '@shared/artifacts'
import { ArtifactContentKind } from '@shared/artifacts'
import { ArtifactViewState } from './ArtifactViewState'
import { useArtifactContent } from './use-artifact-content'

export function MarkdownArtifactView({ artifact, artifactApi, refreshTrigger = 0, onLinkClick }: { artifact: Artifact; artifactApi: ArtifactApi; refreshTrigger?: number; onLinkClick?: (href: string) => boolean }) {
  const state = useArtifactContent(artifact, artifactApi, refreshTrigger)
  const text = state.content?.kind === ArtifactContentKind.TEXT ? state.content.content : null
  return <ArtifactViewState loading={state.loading} error={state.error} missing={text === null}><div className="h-full overflow-y-auto px-6 py-5"><Markdown size="sm" onLinkClick={onLinkClick}>{text || ''}</Markdown></div></ArtifactViewState>
}
