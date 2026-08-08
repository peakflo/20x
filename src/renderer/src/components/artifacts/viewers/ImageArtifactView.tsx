import type { Artifact, ArtifactApi } from '@shared/artifacts'
import { ArtifactContentKind } from '@shared/artifacts'
import { ArtifactViewState } from './ArtifactViewState'
import { useArtifactContent } from './use-artifact-content'

export function ImageArtifactView({ artifact, artifactApi }: { artifact: Artifact; artifactApi: ArtifactApi }) {
  const state = useArtifactContent(artifact, artifactApi)
  const source = artifact.url || (state.content?.kind === ArtifactContentKind.DATA_URL ? state.content.content : null)
  return <ArtifactViewState loading={state.loading} error={state.error} missing={!source}><div className="flex h-full items-center justify-center overflow-auto bg-muted/30 p-4"><img src={source || ''} alt={artifact.title} className="max-h-full max-w-full object-contain" /></div></ArtifactViewState>
}
