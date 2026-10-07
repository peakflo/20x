import { useCallback, useRef, useState } from 'react'
import { Code2, Download, Maximize2 } from 'lucide-react'
import type { Artifact, ArtifactApi } from '@shared/artifacts'
import { ArtifactContentKind } from '@shared/artifacts'
import { clampHtmlRenderHeight, HTML_RENDER_MIN_HEIGHT } from '@shared/html-render'
import { handleArtifactMcpMessage } from '@shared/artifact-mcp-host'
import { useArtifactContent } from './viewers/use-artifact-content'
import { ArtifactViewState } from './viewers/ArtifactViewState'
import { ArtifactHtmlFrame } from './viewers/ArtifactHtmlFrame'

/**
 * Height cache, keyed by artifact id, surviving a remount of this component
 * (e.g. the virtualized transcript recycling rows). Without it, every
 * remount would start from the height hint again and the surrounding rows
 * would visibly jump once the frame reports its real content height.
 */
const heightCache = new Map<string, number>()

function initialHeight(artifact: Artifact): number {
  const cached = heightCache.get(artifact.id)
  if (cached !== undefined) return cached
  return clampHtmlRenderHeight(artifact.heightHint ?? HTML_RENDER_MIN_HEIGHT)
}

/**
 * Inline chat rendering for an HTML artifact published with `html_render`.
 * Wraps `ArtifactHtmlFrame` without `h-full`/the hard-coded white background,
 * so it sits directly in the transcript, auto-sized to its content, themed
 * to match the app, with its own small toolbar instead of the generic
 * open-in-panel card used for other artifact types.
 */
export function InlineHtmlRender({
  artifact, artifactApi, onExpand, onLinkClick, onSaveAs
}: {
  artifact: Artifact
  artifactApi: ArtifactApi
  onExpand: () => void
  onLinkClick?: (href: string) => boolean
  /** Desktop only — omit to hide the "Save as…" toolbar action. */
  onSaveAs?: () => void
}) {
  const state = useArtifactContent(artifact, artifactApi)
  const html = state.content?.kind === ArtifactContentKind.TEXT ? state.content.content : null
  const [height, setHeight] = useState(() => initialHeight(artifact))
  const [viewSource, setViewSource] = useState(false)
  const artifactIdRef = useRef(artifact.id)
  artifactIdRef.current = artifact.id

  const handleContentHeight = useCallback((next: number) => {
    heightCache.set(artifactIdRef.current, next)
    setHeight(next)
  }, [])

  return (
    <div className="my-1 w-full overflow-hidden rounded-lg border border-border/50 bg-card">
      <div className="flex items-center gap-1.5 border-b border-border/40 px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">{artifact.title}</span>
        <button type="button" onClick={() => setViewSource((value) => !value)} aria-label="View source" aria-pressed={viewSource} className={`grid h-6 w-6 shrink-0 place-items-center rounded-md hover:bg-accent ${viewSource ? 'text-primary' : 'text-muted-foreground'}`}>
          <Code2 className="h-3.5 w-3.5" />
        </button>
        {onSaveAs && (
          <button type="button" onClick={onSaveAs} aria-label="Save as…" className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent">
            <Download className="h-3.5 w-3.5" />
          </button>
        )}
        <button type="button" onClick={onExpand} aria-label="Expand" className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent">
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {viewSource ? (
        <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap break-words bg-muted/30 p-3 font-mono text-[11px] text-foreground/80">{html ?? ''}</pre>
      ) : (
        // Reserve the box at the cached/hinted height before first paint —
        // ArtifactHtmlFrame itself auto-sizes, but its *container* must not
        // start at 0 and jump once the frame's first size message arrives.
        <div style={{ height: `${height}px` }} className="w-full">
          <ArtifactViewState loading={state.loading} error={state.error} missing={html === null}>
            <ArtifactHtmlFrame
              key={`${artifact.path}:${artifact.reloadTrigger}`}
              html={html || ''}
              title={artifact.title}
              taskId={artifact.taskId}
              path={artifact.path || ''}
              files={artifact.files || (artifact.path ? [artifact.path] : [])}
              readFile={artifactApi.read}
              onLinkClick={onLinkClick}
              fill={false}
              height={height}
              onContentHeight={handleContentHeight}
              onMessage={(data, reply) => {
                if (html === null || !artifact.path || !artifactApi.mcpCall) return
                void handleArtifactMcpMessage(html, { taskId: artifact.taskId, path: artifact.path }, data, reply, artifactApi.mcpCall)
              }}
            />
          </ArtifactViewState>
        </div>
      )}
    </div>
  )
}
