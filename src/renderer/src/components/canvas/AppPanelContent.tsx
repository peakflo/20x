import { useEffect, useState, useCallback } from 'react'
import { Globe, ExternalLink, Monitor, Loader2, AlertTriangle, RefreshCw } from 'lucide-react'
import { useDashboardStore } from '@/stores/dashboard-store'

interface AppPanelContentProps {
  appId?: string
  url?: string
  title?: string
}

/**
 * Application panel — executes and embeds an application on the canvas.
 * When given an appId (workflowId), it triggers execution via the dashboard store
 * and renders the resulting URL in an iframe.
 */
export function AppPanelContent({ appId, title }: AppPanelContentProps) {
  const openTabs = useDashboardStore((s) => s.openTabs)
  const openApplication = useDashboardStore((s) => s.openApplication)
  const applications = useDashboardStore((s) => s.applications)
  const [launched, setLaunched] = useState(false)

  // Find the tab for this app (if it was already opened via dashboard or canvas)
  const tab = openTabs.find((t) => t.workflowId === appId)

  // Auto-launch the application when first mounted with an appId
  const launchApp = useCallback(async () => {
    if (!appId) return
    setLaunched(true)
    try {
      await openApplication(appId)
    } catch (err) {
      console.error('Failed to launch application on canvas:', err)
    }
  }, [appId, openApplication])

  useEffect(() => {
    if (!appId || launched) return
    // If already in openTabs (launched from dashboard), don't re-execute
    if (tab) {
      setLaunched(true)
      return
    }
    launchApp()
  }, [appId, launched, tab, launchApp])

  // No appId — generic placeholder
  if (!appId) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-2">
          <Monitor className="h-8 w-8 mx-auto text-green-400/20" />
          <div className="text-xs text-muted-foreground/40">
            {title || 'Application Panel'}
          </div>
          <div className="text-[10px] text-muted-foreground/25">
            No application configured
          </div>
        </div>
      </div>
    )
  }

  // Loading state
  if (tab?.executing || tab?.polling) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3">
          <div className="relative mx-auto w-10 h-10">
            <Loader2 className="h-10 w-10 animate-spin text-green-400/30" />
            <div className="absolute inset-0 flex items-center justify-center">
              <Monitor className="h-4 w-4 text-green-400" />
            </div>
          </div>
          <p className="text-sm font-medium text-foreground/80">
            {tab.executing ? 'Executing Application' : 'Preparing Application'}
          </p>
          <p className="text-xs text-muted-foreground/60">
            {tab.executing
              ? 'Starting your application workflow...'
              : 'Waiting for application to be ready...'}
          </p>
          {tab.executionStatus && (
            <p className="text-[11px] text-muted-foreground/40">
              Status: {tab.executionStatus}
            </p>
          )}
        </div>
      </div>
    )
  }

  // Error state
  if (tab?.error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3 max-w-sm px-4">
          <AlertTriangle className="h-8 w-8 text-destructive/60 mx-auto" />
          <p className="text-sm font-medium text-foreground/80">Execution Error</p>
          <p className="text-xs text-muted-foreground/60">{tab.error}</p>
          <button
            onClick={() => {
              setLaunched(false)
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-[var(--color-hover-overlay)] hover:bg-[var(--color-hover-overlay-strong)] text-foreground/70 hover:text-foreground transition-colors"
          >
            <RefreshCw className="h-3 w-3" />
            Retry
          </button>
        </div>
      </div>
    )
  }

  // Ready — render iframe
  if (tab?.url) {
    const appName = applications.find((a) => a.workflowId === appId)?.name || title || 'Application'
    return (
      <div className="flex flex-col h-full min-h-0">
        {/* URL bar */}
        <div className="flex items-center gap-2 px-2 py-1.5 bg-[var(--color-canvas-panel-bg)]/80 border-b border-border/20 flex-shrink-0">
          <Globe className="h-3 w-3 text-green-400/60 flex-shrink-0" />
          <span className="text-[10px] text-muted-foreground/50 truncate flex-1 font-mono">
            {tab.url}
          </span>
          <a
            href={tab.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground/40 hover:text-muted-foreground/80 transition-colors"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>

        {/* Iframe */}
        <div className="flex-1 min-h-0">
          <iframe
            src={tab.url}
            className="w-full h-full border-0"
            title={`Application - ${appName}`}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          />
        </div>
      </div>
    )
  }

  // Waiting to launch / no tab yet
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center space-y-3">
        <div className="relative mx-auto w-10 h-10">
          <Loader2 className="h-10 w-10 animate-spin text-green-400/20" />
          <div className="absolute inset-0 flex items-center justify-center">
            <Monitor className="h-4 w-4 text-green-400/40" />
          </div>
        </div>
        <p className="text-sm font-medium text-foreground/70">
          Launching {title || 'Application'}...
        </p>
      </div>
    </div>
  )
}
