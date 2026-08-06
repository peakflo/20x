import { useEffect, useMemo, useState } from 'react'
import { Markdown } from '@/components/ui/Markdown'
import { ArtifactContentKind, type ArtifactContent } from '@shared/artifacts'
import { api } from '../api/client'
import { ArtifactType, useArtifactStore } from '../stores/artifact-store'
import type { Route } from '../App'

function hardenHtml(source: string): string {
  const policy = "default-src 'none'; connect-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
  const guard = `<meta http-equiv="Content-Security-Policy" content="${policy}"><base href="about:blank"><script>window.open=function(){return null};</script>`
  return /<head[\s>]/i.test(source)
    ? source.replace(/<head([^>]*)>/i, `<head$1>${guard}`)
    : `<!doctype html><html><head>${guard}</head><body>${source}</body></html>`
}

function safeExternalUrl(value?: string): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

export function ArtifactViewerPage({ taskId, artifactId, onNavigate }: { taskId: string; artifactId: string; onNavigate: (route: Route) => void }) {
  const artifact = useArtifactStore((state) => state.artifactsByTask.get(taskId)?.find((item) => item.id === artifactId))
  const hydrate = useArtifactStore((state) => state.hydrate)
  const [content, setContent] = useState<ArtifactContent | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!artifact) void hydrate(taskId)
  }, [artifact, hydrate, taskId])

  useEffect(() => {
    if (!artifact?.path || artifact.type === ArtifactType.PR) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void api.artifacts.content(taskId, artifact.path).then((result) => {
      if (!cancelled) setContent(result)
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [artifact?.path, artifact?.reloadTrigger, artifact?.type, taskId])

  const imageUrl = useMemo(() => {
    if (!content || artifact?.type !== ArtifactType.IMAGE) return null
    return content.kind === ArtifactContentKind.DATA_URL ? content.content : null
  }, [artifact?.type, content])
  const externalUrl = safeExternalUrl(artifact?.url)

  const handleBack = () => {
    if (history.length > 1) history.back()
    else onNavigate({ page: 'detail', taskId })
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-3">
        <button type="button" onClick={handleBack} className="rounded-md p-1.5 active:opacity-60" aria-label="Back to task">
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{artifact?.title || 'Artifact'}</span>
        {artifact?.type === ArtifactType.PR && externalUrl && (
          <a href={externalUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-primary">Open ↗</a>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-[#0d1117]">
        {loading && <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading artifact…</div>}
        {!loading && error && <div className="flex h-full items-center justify-center p-6 text-center text-sm text-red-400">{error}</div>}
        {!loading && !error && !artifact && <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Artifact not found</div>}
        {!loading && !error && artifact?.type === ArtifactType.MARKDOWN && content && (
          <div className="mx-auto max-w-3xl p-5"><Markdown size="sm">{content.content}</Markdown></div>
        )}
        {!loading && !error && artifact?.type === ArtifactType.IMAGE && imageUrl && (
          <div className="flex min-h-full items-center justify-center p-4"><img src={imageUrl} alt={artifact.title} className="max-h-full max-w-full object-contain" /></div>
        )}
        {!loading && !error && artifact?.type === ArtifactType.HTML && content && (
          <iframe
            key={artifact.reloadTrigger}
            title={artifact.title}
            srcDoc={hardenHtml(content.content)}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className="h-full w-full border-0 bg-white"
          />
        )}
        {!loading && !error && artifact?.type === ArtifactType.FILE && content && (
          <pre className="min-h-full whitespace-pre-wrap break-words p-4 font-mono text-xs text-gray-300">{content.kind === ArtifactContentKind.TEXT ? content.content : 'Binary file preview is not available.'}</pre>
        )}
        {!loading && !error && artifact?.type === ArtifactType.PR && (
          <div className="p-5"><div className="rounded-md border border-border/50 bg-[#161b22] p-4"><div className="font-medium">{artifact.title}</div><p className="mt-1 text-xs text-muted-foreground">Open this pull request in your browser to review status and checks.</p></div></div>
        )}
      </div>
    </div>
  )
}
