import { Globe, ExternalLink, RefreshCw, ArrowRight } from 'lucide-react'
import { useState, useCallback } from 'react'
import { useCanvasStore } from '@/stores/canvas-store'

interface WebPagePanelContentProps {
  panelId: string
  url?: string
  title?: string
}

/**
 * Embeds a user-provided URL in an iframe on the canvas.
 * When no URL is set, shows an editable URL bar for the user to type in.
 * The URL bar is always editable — click it to change the address.
 */
export function WebPagePanelContent({ panelId, url, title }: WebPagePanelContentProps) {
  const updatePanel = useCanvasStore((s) => s.updatePanel)
  const [iframeKey, setIframeKey] = useState(0)
  const [isEditing, setIsEditing] = useState(!url)
  const [inputValue, setInputValue] = useState(url || '')

  const handleRefresh = useCallback(() => {
    setIframeKey((k) => k + 1)
  }, [])

  const handleNavigate = useCallback(() => {
    let newUrl = inputValue.trim()
    if (!newUrl) return
    if (!/^https?:\/\//i.test(newUrl)) {
      newUrl = 'https://' + newUrl
    }
    let displayTitle: string
    try {
      displayTitle = new URL(newUrl).hostname
    } catch {
      displayTitle = newUrl
    }
    updatePanel(panelId, { url: newUrl, title: displayTitle })
    setInputValue(newUrl)
    setIsEditing(false)
    setIframeKey((k) => k + 1)
  }, [inputValue, panelId, updatePanel])

  // Empty state — no URL yet, show centered input
  if (!url && !isEditing) {
    setIsEditing(true)
  }

  if (!url || isEditing) {
    return (
      <div className="flex flex-col h-full min-h-0">
        {/* Editable URL bar */}
        <form
          onSubmit={(e) => { e.preventDefault(); handleNavigate() }}
          className="flex items-center gap-2 px-2 py-1.5 bg-[var(--color-canvas-panel-bg)]/80 border-b border-border/20 flex-shrink-0"
        >
          <Globe className="h-3 w-3 text-cyan-400/60 flex-shrink-0" />
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && url) { setIsEditing(false); setInputValue(url) } }}
            placeholder="Enter URL — e.g. google.com"
            autoFocus
            className="flex-1 text-[11px] bg-transparent text-foreground placeholder:text-muted-foreground/30 focus:outline-none font-mono"
          />
          <button
            type="submit"
            disabled={!inputValue.trim()}
            className="text-cyan-400/60 hover:text-cyan-400 disabled:text-muted-foreground/20 transition-colors"
            title="Go"
          >
            <ArrowRight className="h-3 w-3" />
          </button>
        </form>

        {/* Empty state body */}
        {!url && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center space-y-2 px-6">
              <Globe className="h-10 w-10 mx-auto text-cyan-400/15" />
              <div className="text-xs text-muted-foreground/40">
                Type a URL above and press Enter to load a website
              </div>
            </div>
          </div>
        )}

        {/* If editing an existing URL, still show the iframe behind */}
        {url && (
          <div className="flex-1 min-h-0 opacity-30">
            <iframe
              key={iframeKey}
              src={url}
              className="w-full h-full border-0"
              title={title || url}
            />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* URL bar — click to edit */}
      <div className="flex items-center gap-2 px-2 py-1.5 bg-[var(--color-canvas-panel-bg)]/80 border-b border-border/20 flex-shrink-0">
        <Globe className="h-3 w-3 text-cyan-400/60 flex-shrink-0" />
        <button
          onClick={() => { setIsEditing(true); setInputValue(url) }}
          className="flex-1 text-left text-[11px] text-muted-foreground/50 truncate font-mono hover:text-muted-foreground/80 transition-colors"
          title="Click to edit URL"
        >
          {url}
        </button>
        <button
          onClick={handleRefresh}
          className="text-muted-foreground/40 hover:text-muted-foreground/80 transition-colors"
          title="Refresh"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground/40 hover:text-muted-foreground/80 transition-colors"
          onClick={(e) => e.stopPropagation()}
          title="Open in browser"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      {/* Iframe */}
      <div className="flex-1 min-h-0">
        <iframe
          key={iframeKey}
          src={url}
          className="w-full h-full border-0"
          title={title || url}
        />
      </div>
    </div>
  )
}
