import { Globe, ExternalLink, RefreshCw } from 'lucide-react'
import { useState, useCallback } from 'react'

interface WebPagePanelContentProps {
  url: string
  title?: string
}

/**
 * Embeds a user-provided URL in an iframe on the canvas.
 */
export function WebPagePanelContent({ url, title }: WebPagePanelContentProps) {
  const [iframeKey, setIframeKey] = useState(0)

  const handleRefresh = useCallback(() => {
    setIframeKey((k) => k + 1)
  }, [])

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* URL bar */}
      <div className="flex items-center gap-2 px-2 py-1.5 bg-[#0d1117]/40 border-b border-border/20 flex-shrink-0">
        <Globe className="h-3 w-3 text-blue-400/60 flex-shrink-0" />
        <span className="text-[10px] text-muted-foreground/50 truncate flex-1 font-mono">
          {url}
        </span>
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
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        />
      </div>
    </div>
  )
}
