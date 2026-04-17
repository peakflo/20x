import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Globe,
  RefreshCw,
  ArrowLeft,
  ArrowRight,
  Loader2,
  Zap,
} from 'lucide-react'
import { useCanvasStore } from '@/stores/canvas-store'

interface BrowserPanelContentProps {
  panelId: string
  /** Initial URL to load */
  url?: string
  sessionName?: string
  streamPort?: number
}

/** CDP port exposed by the Electron app for agent-browser to connect to */
const CDP_PORT = 19222

/**
 * Canvas panel with a real Electron <webview> — a fully interactive browser.
 *
 * The agent can control this browser via CDP (connecting to the webview's
 * debugger port), and the user sees + interacts with the same page live
 * on the canvas.
 */
export function BrowserPanelContent({
  panelId,
  url: initialUrl,
}: BrowserPanelContentProps) {
  const updatePanel = useCanvasStore((s) => s.updatePanel)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webviewRef = useRef<any>(null)

  const [currentUrl, setCurrentUrl] = useState(initialUrl || '')
  const [inputValue, setInputValue] = useState(initialUrl || '')
  const [isLoading, setIsLoading] = useState(false)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [isSetup, setIsSetup] = useState(!initialUrl)

  // ── Check if this browser is connected to a task via an edge ──
  // Uses imperative reads + subscribe to avoid re-rendering on every panel move
  const [connectedTaskName, setConnectedTaskName] = useState<string | null>(null)

  useEffect(() => {
    function computeConnectedTask(): string | null {
      const { edges, panels } = useCanvasStore.getState()
      const browserEdges = edges.filter(
        (e) =>
          e.edgeType === 'browser' &&
          (e.fromPanelId === panelId || e.toPanelId === panelId)
      )
      if (browserEdges.length === 0) return null
      for (const edge of browserEdges) {
        const otherId = edge.fromPanelId === panelId ? edge.toPanelId : edge.fromPanelId
        const otherPanel = panels.find((p) => p.id === otherId)
        if (otherPanel?.type === 'task') return otherPanel.title
      }
      return 'Agent'
    }

    setConnectedTaskName(computeConnectedTask())

    // Only re-compute when edges change, not on every panel position change
    const unsub = useCanvasStore.subscribe((state, prevState) => {
      if (state.edges !== prevState.edges) {
        setConnectedTaskName(computeConnectedTask())
      }
    })
    return unsub
  }, [panelId])

  // ── Webview event wiring ──────────────────────────────────
  // Debounce store updates to avoid re-render storms from SPA sites (e.g. Google Maps)
  const pendingUrlUpdate = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingTitleUpdate = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return

    const onStartLoading = () => setIsLoading(true)
    const onStopLoading = () => {
      setIsLoading(false)
      setCanGoBack(wv.canGoBack())
      setCanGoForward(wv.canGoForward())
    }
    const onNavigate = (e: { url: string }) => {
      // Update local state immediately (fast UI)
      setCurrentUrl(e.url)
      setInputValue(e.url)
      // Debounce store update to avoid flooding zustand on SPA navigations
      if (pendingUrlUpdate.current) clearTimeout(pendingUrlUpdate.current)
      pendingUrlUpdate.current = setTimeout(() => {
        updatePanel(panelId, { url: e.url })
      }, 500)
    }
    const onTitleUpdate = (e: { title: string }) => {
      if (pendingTitleUpdate.current) clearTimeout(pendingTitleUpdate.current)
      pendingTitleUpdate.current = setTimeout(() => {
        updatePanel(panelId, { title: e.title || 'Browser' })
      }, 500)
    }

    wv.addEventListener('did-start-loading', onStartLoading)
    wv.addEventListener('did-stop-loading', onStopLoading)
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigate as any)
    wv.addEventListener('page-title-updated', onTitleUpdate)

    return () => {
      wv.removeEventListener('did-start-loading', onStartLoading)
      wv.removeEventListener('did-stop-loading', onStopLoading)
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigate as any)
      wv.removeEventListener('page-title-updated', onTitleUpdate)
      if (pendingUrlUpdate.current) clearTimeout(pendingUrlUpdate.current)
      if (pendingTitleUpdate.current) clearTimeout(pendingTitleUpdate.current)
    }
  }, [panelId, updatePanel, isSetup])

  // ── Navigation handlers ───────────────────────────────────
  const navigate = useCallback((url: string) => {
    let finalUrl = url.trim()
    if (!finalUrl) return
    if (!/^https?:\/\//i.test(finalUrl)) {
      // Check if it looks like a URL or a search query
      if (/^[\w-]+\.[\w]{2,}/.test(finalUrl)) {
        finalUrl = 'https://' + finalUrl
      } else {
        finalUrl = `https://www.google.com/search?q=${encodeURIComponent(finalUrl)}`
      }
    }
    setCurrentUrl(finalUrl)
    setInputValue(finalUrl)
    setIsSetup(false)
    const wv = webviewRef.current
    if (wv) {
      wv.loadURL(finalUrl)
    }
  }, [])

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    navigate(inputValue)
  }, [inputValue, navigate])

  const handleBack = useCallback(() => {
    webviewRef.current?.goBack()
  }, [])

  const handleForward = useCallback(() => {
    webviewRef.current?.goForward()
  }, [])

  const handleRefresh = useCallback(() => {
    webviewRef.current?.reload()
  }, [])

  // ── Setup screen ──────────────────────────────────────────
  if (isSetup) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <BrowserUrlBar
          inputValue={inputValue}
          isLoading={false}
          canGoBack={false}
          canGoForward={false}
          onInputChange={setInputValue}
          onSubmit={handleSubmit}
          onBack={handleBack}
          onForward={handleForward}
          onRefresh={handleRefresh}
          connectedTaskName={connectedTaskName}
          autoFocus
        />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3 px-6">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-orange-500/10 flex items-center justify-center">
              <Globe className="h-7 w-7 text-orange-400/60" />
            </div>
            <div>
              <div className="text-sm font-medium text-foreground/70 mb-1">Browser</div>
              <div className="text-[11px] text-muted-foreground/40 leading-relaxed max-w-[240px]">
                Type a URL or search query above. This is a real browser —
                the agent can control it and you can interact with it.
              </div>
              <div className="mt-3 text-[10px] text-muted-foreground/30 font-mono">
                CDP port {CDP_PORT}
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Live browser ──────────────────────────────────────────
  return (
    <div className="flex flex-col h-full min-h-0">
      <BrowserUrlBar
        inputValue={inputValue}
        isLoading={isLoading}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onInputChange={setInputValue}
        onSubmit={handleSubmit}
        onBack={handleBack}
        onForward={handleForward}
        onRefresh={handleRefresh}
        connectedTaskName={connectedTaskName}
      />

      {/* Webview — real browser */}
      <div className="flex-1 min-h-0">
        <webview
          ref={webviewRef as any}
          src={currentUrl}
          className="w-full h-full"
          /* @ts-expect-error — Electron webview attributes not typed in JSX */
          allowpopups="true"
          style={{ display: 'flex', flex: 1, width: '100%', height: '100%' }}
        />
      </div>
    </div>
  )
}

// ── URL Bar component ─────────────────────────────────────────

function BrowserUrlBar({
  inputValue,
  isLoading,
  canGoBack,
  canGoForward,
  onInputChange,
  onSubmit,
  onBack,
  onForward,
  onRefresh,
  connectedTaskName,
  autoFocus,
}: {
  inputValue: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  onInputChange: (v: string) => void
  onSubmit: (e: React.FormEvent) => void
  onBack: () => void
  onForward: () => void
  onRefresh: () => void
  connectedTaskName?: string | null
  autoFocus?: boolean
}) {
  return (
    <form
      onSubmit={onSubmit}
      className="flex items-center gap-1.5 px-2 py-1.5 bg-[#0d1117]/60 border-b border-border/20 flex-shrink-0"
    >
      {/* Nav buttons */}
      <button
        type="button"
        onClick={onBack}
        disabled={!canGoBack}
        className="h-5 w-5 rounded flex items-center justify-center text-muted-foreground/40 hover:text-muted-foreground hover:bg-white/5 disabled:opacity-20 disabled:hover:bg-transparent transition-colors"
        title="Back"
      >
        <ArrowLeft className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={onForward}
        disabled={!canGoForward}
        className="h-5 w-5 rounded flex items-center justify-center text-muted-foreground/40 hover:text-muted-foreground hover:bg-white/5 disabled:opacity-20 disabled:hover:bg-transparent transition-colors"
        title="Forward"
      >
        <ArrowRight className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={onRefresh}
        className="h-5 w-5 rounded flex items-center justify-center text-muted-foreground/40 hover:text-muted-foreground hover:bg-white/5 transition-colors"
        title="Refresh"
      >
        {isLoading ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <RefreshCw className="h-3 w-3" />
        )}
      </button>

      {/* URL input */}
      <div className="flex-1 flex items-center gap-1.5 bg-[#1a2030] rounded-md px-2 py-1 border border-border/20 focus-within:border-orange-500/30 transition-colors">
        <Globe className="h-3 w-3 text-muted-foreground/30 flex-shrink-0" />
        <input
          type="text"
          value={inputValue}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder="Search or enter URL"
          autoFocus={autoFocus}
          className="flex-1 text-[11px] bg-transparent text-foreground placeholder:text-muted-foreground/25 focus:outline-none font-mono"
          onFocus={(e) => e.target.select()}
        />
      </div>

      {/* Agent connection indicator */}
      {connectedTaskName && (
        <div
          className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-orange-500/10 border border-orange-500/20 flex-shrink-0"
          title={`Connected to "${connectedTaskName}" — agent can control this browser via CDP port ${CDP_PORT}`}
        >
          <Zap className="h-2.5 w-2.5 text-orange-400" />
          <span className="text-[9px] font-medium text-orange-400/80 whitespace-nowrap">
            CDP
          </span>
        </div>
      )}
    </form>
  )
}
