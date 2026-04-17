import { useState, useEffect, useCallback } from 'react'
import {
  Globe,
  RefreshCw,
  Play,
  Wifi,
  WifiOff,
  Monitor,
  Loader2,
} from 'lucide-react'
import { useBrowserStore, type BrowserSession } from '@/stores/browser-store'

interface BrowserPanelContentProps {
  panelId: string
  sessionName?: string
  streamPort?: number
}

/**
 * Canvas panel content for agent-browser sessions.
 *
 * Shows one of three states:
 * 1. Setup — user enters session name / starts browser
 * 2. Connecting — trying to connect to agent-browser WebSocket stream
 * 3. Live — shows dashboard viewport iframe + live status bar with tabs/URL
 *
 * The agent-browser dashboard on localhost:4848 provides a ready-made viewport.
 * We embed it and overlay a status bar showing real-time info from the WebSocket stream.
 */
export function BrowserPanelContent({
  panelId,
  sessionName: initialSessionName,
  streamPort: initialStreamPort,
}: BrowserPanelContentProps) {
  const createSession = useBrowserStore((s) => s.createSession)
  const connectStream = useBrowserStore((s) => s.connectStream)
  const sessions = useBrowserStore((s) => s.sessions)

  const [sessionName, setSessionName] = useState(initialSessionName || '')
  const [port, setPort] = useState(initialStreamPort?.toString() || '')
  const [isSetup, setIsSetup] = useState(!initialSessionName && !initialStreamPort)
  const [dashboardUrl, setDashboardUrl] = useState<string | null>(null)
  const [iframeKey, setIframeKey] = useState(0)
  const [isStarting, setIsStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  const session = sessions.get(sessionName)

  // Auto-connect if we have initial props
  useEffect(() => {
    if (initialSessionName && initialStreamPort) {
      const existing = useBrowserStore.getState().sessions.get(initialSessionName)
      if (!existing) {
        createSession(initialSessionName, panelId)
      }
      connectStream(initialSessionName, initialStreamPort)
      setDashboardUrl('http://localhost:4848')
      setSessionName(initialSessionName)
      setIsSetup(false)
    }
  }, [initialSessionName, initialStreamPort, panelId, createSession, connectStream])

  const handleStartBrowser = useCallback(async () => {
    const name = sessionName.trim() || 'default'
    const streamPort = port.trim() ? parseInt(port.trim(), 10) : undefined

    setIsStarting(true)
    setStartError(null)

    try {
      // Create session in store
      createSession(name, panelId)

      // Try to start the agent-browser dashboard if not running
      // The dashboard serves the viewport at localhost:4848
      setDashboardUrl('http://localhost:4848')

      // If a specific stream port was provided, connect to the stream
      if (streamPort) {
        connectStream(name, streamPort)
      }

      setSessionName(name)
      setIsSetup(false)
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Failed to start browser')
    } finally {
      setIsStarting(false)
    }
  }, [sessionName, port, panelId, createSession, connectStream])

  const handleRefresh = useCallback(() => {
    setIframeKey((k) => k + 1)
  }, [])

  // Setup screen
  if (isSetup) {
    return <BrowserSetupView
      sessionName={sessionName}
      port={port}
      isStarting={isStarting}
      startError={startError}
      onSessionNameChange={setSessionName}
      onPortChange={setPort}
      onStart={handleStartBrowser}
    />
  }

  // Live browser view
  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Status bar */}
      <BrowserStatusBar
        session={session}
        sessionName={sessionName}
        onRefresh={handleRefresh}
      />

      {/* Dashboard viewport iframe */}
      {dashboardUrl ? (
        <div className="flex-1 min-h-0 relative">
          <iframe
            key={iframeKey}
            src={dashboardUrl}
            className="w-full h-full border-0"
            title={`Browser: ${sessionName}`}
            allow="clipboard-read; clipboard-write"
          />
          {/* Subtle overlay when not connected */}
          {session && !session.connected && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
              <div className="text-center space-y-2">
                <WifiOff className="h-6 w-6 mx-auto text-orange-400/60" />
                <p className="text-xs text-muted-foreground/60">
                  Waiting for agent-browser stream...
                </p>
                <p className="text-[10px] text-muted-foreground/40">
                  Run: agent-browser stream enable
                </p>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-2 px-6">
            <Monitor className="h-10 w-10 mx-auto text-orange-400/15" />
            <div className="text-xs text-muted-foreground/40">
              Dashboard not available
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Setup View ────────────────────────────────────────────────

function BrowserSetupView({
  sessionName,
  port,
  isStarting,
  startError,
  onSessionNameChange,
  onPortChange,
  onStart,
}: {
  sessionName: string
  port: string
  isStarting: boolean
  startError: string | null
  onSessionNameChange: (v: string) => void
  onPortChange: (v: string) => void
  onStart: () => void
}) {
  return (
    <div className="flex flex-col h-full items-center justify-center p-6">
      <div className="w-full max-w-[280px] space-y-4">
        <div className="text-center space-y-2">
          <div className="w-12 h-12 mx-auto rounded-xl bg-orange-500/10 flex items-center justify-center">
            <Globe className="h-6 w-6 text-orange-400" />
          </div>
          <h3 className="text-sm font-medium text-foreground">Agent Browser</h3>
          <p className="text-[11px] text-muted-foreground/50 leading-relaxed">
            Connect to an agent-browser session to see live browser activity on the canvas.
          </p>
        </div>

        <form
          onSubmit={(e) => { e.preventDefault(); onStart() }}
          className="space-y-3"
        >
          <div className="space-y-1">
            <label className="text-[10px] text-muted-foreground/40 uppercase tracking-wider">
              Session Name
            </label>
            <input
              type="text"
              value={sessionName}
              onChange={(e) => onSessionNameChange(e.target.value)}
              placeholder="default"
              className="w-full text-xs bg-[#0d1117] border border-border/30 rounded-lg px-3 py-2 text-foreground placeholder:text-muted-foreground/25 focus:outline-none focus:border-orange-500/50"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[10px] text-muted-foreground/40 uppercase tracking-wider">
              Stream Port (optional)
            </label>
            <input
              type="text"
              value={port}
              onChange={(e) => onPortChange(e.target.value)}
              placeholder="Auto-detect from agent-browser"
              className="w-full text-xs bg-[#0d1117] border border-border/30 rounded-lg px-3 py-2 text-foreground placeholder:text-muted-foreground/25 focus:outline-none focus:border-orange-500/50"
            />
          </div>

          {startError && (
            <p className="text-[11px] text-red-400/80">{startError}</p>
          )}

          <button
            type="submit"
            disabled={isStarting}
            className="w-full flex items-center justify-center gap-2 text-xs font-medium bg-orange-500/20 hover:bg-orange-500/30 text-orange-400 rounded-lg px-3 py-2.5 transition-colors disabled:opacity-50"
          >
            {isStarting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {isStarting ? 'Connecting...' : 'Connect to Browser'}
          </button>
        </form>

        <div className="text-center">
          <p className="text-[10px] text-muted-foreground/30 leading-relaxed">
            First run:{' '}
            <code className="text-orange-400/50 bg-orange-400/5 px-1 py-0.5 rounded">
              agent-browser --headed open &lt;url&gt;
            </code>
            <br />
            then:{' '}
            <code className="text-orange-400/50 bg-orange-400/5 px-1 py-0.5 rounded">
              agent-browser stream enable
            </code>
          </p>
        </div>
      </div>
    </div>
  )
}

// ── Status Bar ────────────────────────────────────────────────

function BrowserStatusBar({
  session,
  sessionName,
  onRefresh,
}: {
  session: BrowserSession | undefined
  sessionName: string
  onRefresh: () => void
}) {
  const activeTab = session?.tabs.find((t) => t.active)
  const displayUrl = session?.currentUrl || activeTab?.url || null

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 bg-[#0d1117]/60 border-b border-border/20 flex-shrink-0">
      {/* Connection indicator */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {session?.connected ? (
          <div className="relative">
            <Wifi className="h-3 w-3 text-green-400" />
            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
          </div>
        ) : (
          <WifiOff className="h-3 w-3 text-muted-foreground/30" />
        )}
        <span className="text-[10px] text-muted-foreground/40 font-mono">
          {sessionName}
        </span>
      </div>

      {/* Divider */}
      <div className="w-px h-3 bg-border/20" />

      {/* URL display */}
      <div className="flex-1 min-w-0">
        {displayUrl ? (
          <span className="text-[11px] text-muted-foreground/50 truncate block font-mono">
            {displayUrl}
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground/25 italic">
            No page loaded
          </span>
        )}
      </div>

      {/* Action indicator */}
      {session?.lastCommand && (
        <span className="text-[9px] text-orange-400/50 bg-orange-400/5 px-1.5 py-0.5 rounded flex-shrink-0">
          {session.lastCommand}
        </span>
      )}

      {/* Tab count */}
      {session && session.tabs.length > 1 && (
        <span className="text-[9px] text-muted-foreground/30 flex-shrink-0">
          {session.tabs.length} tabs
        </span>
      )}

      {/* Refresh */}
      <button
        onClick={onRefresh}
        className="text-muted-foreground/30 hover:text-muted-foreground/60 transition-colors flex-shrink-0"
        title="Refresh dashboard"
      >
        <RefreshCw className="h-3 w-3" />
      </button>
    </div>
  )
}
