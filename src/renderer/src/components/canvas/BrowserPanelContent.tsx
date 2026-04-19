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

  // initialSrc is set once and never changed — prevents the webview from
  // reloading when React re-renders.  All subsequent navigations go through
  // webviewRef.current.loadURL() which doesn't touch this ref.
  const DEFAULT_URL = 'https://www.google.com'
  const initialSrc = useRef(initialUrl || DEFAULT_URL)
  const [inputValue, setInputValue] = useState(initialUrl || DEFAULT_URL)
  const [isLoading, setIsLoading] = useState(false)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)

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

  // ── Resolve CDP target ID once the webview is ready ──────
  // The webview exposes getWebContentsId() which we send to main process
  // to get the CDP target ID — stored on the panel for agent-browser to use.
  const cdpTargetResolved = useRef(false)
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv || cdpTargetResolved.current) return

    const resolveTargetId = async () => {
      try {
        // First try via IPC (uses debugger API or CDP match in main process)
        const wcId = wv.getWebContentsId?.()
        console.log(`[BrowserPanel:${panelId}] webContentsId=${wcId}, url=${wv.getURL?.()?.slice(0, 60)}`)
        if (wcId) {
          // Store webContentsId on panel for reliable CDP target resolution
          updatePanel(panelId, { webContentsId: wcId })
          const result = await window.electronAPI.browser.getTargetId(wcId)
          if (result.targetId) {
            cdpTargetResolved.current = true
            updatePanel(panelId, { cdpTargetId: result.targetId, webContentsId: wcId })
            return
          }
        }

        // Fallback: query CDP targets via IPC (avoids CORS) and match by webview URL
        const wvUrl = wv.getURL?.()
        if (!wvUrl) return
        const targets = await window.electronAPI.browser.getCdpTargets()
        const match = targets.find((t) => t.url === wvUrl)
        if (match) {
          cdpTargetResolved.current = true
          updatePanel(panelId, { cdpTargetId: match.id })
        }
      } catch {
        // Silently ignore — webview may not be ready yet
      }
    }

    wv.addEventListener('did-navigate', resolveTargetId)
    wv.addEventListener('dom-ready', resolveTargetId)
    // Also try immediately in case it's already loaded
    resolveTargetId()
    return () => {
      wv.removeEventListener('did-navigate', resolveTargetId)
      wv.removeEventListener('dom-ready', resolveTargetId)
    }
  }, [panelId, updatePanel])

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
      // Only update the URL bar text — never feed back into <webview src>
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

    // Prevent webview from going fullscreen — it covers the entire app
    const onEnterFullScreen = () => {
      // Immediately exit fullscreen by pressing Escape in the webview
      wv.executeJavaScript('document.exitFullscreen?.().catch(()=>{})').catch(() => {})
    }

    wv.addEventListener('did-start-loading', onStartLoading)
    wv.addEventListener('did-stop-loading', onStopLoading)
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigate as any)
    wv.addEventListener('page-title-updated', onTitleUpdate)
    wv.addEventListener('enter-html-full-screen', onEnterFullScreen)

    return () => {
      wv.removeEventListener('did-start-loading', onStartLoading)
      wv.removeEventListener('did-stop-loading', onStopLoading)
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigate as any)
      wv.removeEventListener('page-title-updated', onTitleUpdate)
      wv.removeEventListener('enter-html-full-screen', onEnterFullScreen)
      if (pendingUrlUpdate.current) clearTimeout(pendingUrlUpdate.current)
      if (pendingTitleUpdate.current) clearTimeout(pendingTitleUpdate.current)
    }
  }, [panelId, updatePanel])

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
    setInputValue(finalUrl)
    // Navigate via loadURL — never set the src attribute reactively
    const wv = webviewRef.current
    if (wv) {
      wv.loadURL(finalUrl)
    } else {
      // Webview not mounted yet — set initial src for first render
      initialSrc.current = finalUrl
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
          src={initialSrc.current}
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
