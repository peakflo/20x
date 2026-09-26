import type { Artifact, ArtifactApi } from '@shared/artifacts'
import { ArtifactContentKind } from '@shared/artifacts'
import { ArtifactViewState } from './ArtifactViewState'
import { useArtifactContent } from './use-artifact-content'

export function FileArtifactView({ artifact, artifactApi, refreshTrigger = 0 }: { artifact: Artifact; artifactApi: ArtifactApi; refreshTrigger?: number }) {
  const state = useArtifactContent(artifact, artifactApi, refreshTrigger)
  const text = state.content?.kind === ArtifactContentKind.TEXT ? state.content.content : null
  const media = state.content?.kind === ArtifactContentKind.DATA_URL ? state.content : null
  return <ArtifactViewState loading={state.loading} error={state.error} missing={state.content === null}>
    {media?.mimeType?.startsWith('video/') ? <video controls src={media.content} className="h-full w-full object-contain" />
      : media?.mimeType?.startsWith('audio/') ? <audio controls src={media.content} className="w-full" />
        : <pre className="h-full overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs text-foreground/80">{text ?? 'Binary file preview is not available. Use Copy file to open it in another application.'}</pre>}
  </ArtifactViewState>
}
