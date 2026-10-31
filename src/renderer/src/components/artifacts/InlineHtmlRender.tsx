import { useCallback, useRef, useState } from 'react'
import type { Artifact, ArtifactApi } from '@shared/artifacts'
import { ArtifactContentKind } from '@shared/artifacts'
import { clampHtmlRenderHeight, HTML_RENDER_MIN_HEIGHT } from '@shared/html-render'
import { handleArtifactMcpMessage } from '@shared/artifact-mcp-host'
import { useArtifactContent } from './viewers/use-artifact-content'
import { ArtifactViewState } from './viewers/ArtifactViewState'
import { ArtifactHtmlFrame } from './viewers/ArtifactHtmlFrame'
import type { InlineHtmlChoice } from '@shared/inline-html-choice'

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
 * so it sits directly in the transcript, auto-sized to its content, and
 * themed to match the app. Artifact actions remain in the artifact panel.
 */
export function InlineHtmlRender({
  artifact, artifactApi, onLinkClick, onChoice, sourceMessageId
}: {
  artifact: Artifact
  artifactApi: ArtifactApi
  onLinkClick?: (href: string) => boolean
  onChoice?: (text: string, choice: InlineHtmlChoice) => void | Promise<unknown>
  sourceMessageId?: string
}) {
  const state = useArtifactContent(artifact, artifactApi)
  const html = state.content?.kind === ArtifactContentKind.TEXT ? state.content.content : null
  const [height, setHeight] = useState(() => initialHeight(artifact))
  const artifactIdRef = useRef(artifact.id)
  artifactIdRef.current = artifact.id

  const handleContentHeight = useCallback((next: number) => {
    heightCache.set(artifactIdRef.current, next)
    setHeight(next)
  }, [])

  return (
    <div data-testid="inline-html-render" className="my-1 w-full overflow-hidden">
      {/* Reserve the hinted height before the frame reports its content height. */}
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
            onChoice={onChoice && sourceMessageId ? (choice) => onChoice(choice.text, {
              sourceMessageId, action: choice.action, data: choice.data
            }) : undefined}
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
    </div>
  )
}
