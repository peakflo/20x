import { useEffect, useMemo } from 'react'
import type { Artifact, ArtifactApi } from '@shared/artifacts'
import { ArtifactContentKind } from '@shared/artifacts'
import { ArtifactViewState } from './ArtifactViewState'
import { useArtifactContent } from './use-artifact-content'

const HARDENING = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:"><script>window.open=function(){return null};</script>`

export function HtmlArtifactView({ artifact, artifactApi, onMessage, refreshTrigger = 0 }: { artifact: Artifact; artifactApi: ArtifactApi; onMessage?: (data: unknown) => void; refreshTrigger?: number }) {
  const state = useArtifactContent(artifact, artifactApi, refreshTrigger)
  const html = state.content?.kind === ArtifactContentKind.TEXT ? state.content.content : null
  const srcDoc = useMemo(() => html === null ? '' : `${HARDENING}${html}`, [html])

  useEffect(() => {
    if (!onMessage) return
    const listener = (event: MessageEvent) => {
      if (event.origin === 'null') onMessage(event.data)
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [onMessage])

  return <ArtifactViewState loading={state.loading} error={state.error} missing={html === null}><iframe key={artifact.reloadTrigger} title={artifact.title} sandbox="allow-scripts" srcDoc={srcDoc} className="h-full w-full border-0 bg-white" /></ArtifactViewState>
}
