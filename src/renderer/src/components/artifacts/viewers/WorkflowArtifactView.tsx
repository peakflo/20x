import { useRef, useState } from 'react'
import { ExternalLink, RefreshCw, Workflow } from 'lucide-react'
import { AGENT_BROWSER_PARTITION } from '@shared/agent-browser-session'
import { workflowPanelRefFromUrl, type Artifact } from '@shared/artifacts'
import { Button } from '@/components/ui/Button'

/** Desktop Electron exposes the `<webview>` tag; the mobile web build and
 * tests do not. Without it the view shows a link card only. */
function canEmbedWebview(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI && typeof document !== 'undefined'
    && typeof (document.createElement('webview') as HTMLElement & { reload?: unknown }).reload !== 'undefined'
}

function openInBrowser(url: string): void {
  if (window.electronAPI?.shell?.openExternal) void window.electronAPI.shell.openExternal(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * A Spaces workflow summary in the artifacts panel.
 *
 * The Spaces page at `panelUrl` (`/flow?workflowId=…&view=summary`) already
 * shows the name, trigger, on/off state, last run, output files and actions.
 * 20x embeds that page instead of copying it, so both apps stay the same.
 * It uses a `<webview>` in the persistent in-app browser session (the same
 * session as the canvas browser panel), so a Spaces sign-in made there, or a
 * session imported into it, is reused. The page never runs in the 20x window
 * itself. "Open in browser" is the fallback.
 */
export function WorkflowArtifactView({ artifact }: { artifact: Artifact }) {
  const ref = workflowPanelRefFromUrl(artifact.url)
  const webviewRef = useRef<HTMLElement & { reload?: () => void }>(null)
  const [embed] = useState(canEmbedWebview)

  if (!ref) {
    return <div role="alert" className="p-4 text-sm text-muted-foreground">This workflow link is not valid.</div>
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-workflow-artifact={ref.workflowId}>
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
        <Workflow className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={artifact.title}>{artifact.title}</span>
        {embed && (
          <Button variant="ghost" size="sm" aria-label="Reload workflow" title="Reload" onClick={() => webviewRef.current?.reload?.()}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => openInBrowser(ref.url)}>
          <ExternalLink className="h-3.5 w-3.5" /> Open in browser
        </Button>
      </div>
      {embed ? (
        <div className="min-h-0 flex-1">
          <webview
            ref={webviewRef as never}
            src={ref.url}
            partition={AGENT_BROWSER_PARTITION}
            className="h-full w-full"
            style={{ display: 'flex', width: '100%', height: '100%' }}
          />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-center">
          <div className="max-w-sm space-y-2">
            <Workflow className="mx-auto h-8 w-8 text-muted-foreground/60" />
            <p className="text-sm text-foreground">{artifact.title}</p>
            <p className="text-xs text-muted-foreground">Open the workflow in Spaces to see its schedule, status, last run and files.</p>
          </div>
        </div>
      )}
    </div>
  )
}
