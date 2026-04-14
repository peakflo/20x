import { Globe, ExternalLink, Monitor } from 'lucide-react'

interface AppPanelContentProps {
  appId?: string
  url?: string
  title?: string
}

/**
 * Application panel — embeds an app/tool view on the canvas.
 * For now shows a placeholder with optional URL that will be expanded
 * with iframe embedding and more app integrations in the future.
 */
export function AppPanelContent({ appId, url, title }: AppPanelContentProps) {
  if (url) {
    return (
      <div className="flex flex-col h-full min-h-0">
        {/* URL bar */}
        <div className="flex items-center gap-2 px-2 py-1.5 bg-[#0d1117]/40 border-b border-border/20 rounded-t flex-shrink-0">
          <Globe className="h-3 w-3 text-muted-foreground/40 flex-shrink-0" />
          <span className="text-[10px] text-muted-foreground/50 truncate flex-1 font-mono">
            {url}
          </span>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground/40 hover:text-muted-foreground/80 transition-colors"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>

        {/* Embed area */}
        <div className="flex-1 bg-[#0d1117]/20 flex items-center justify-center min-h-0">
          <div className="text-center space-y-2 p-4">
            <Monitor className="h-8 w-8 mx-auto text-green-400/30" />
            <div className="text-xs text-muted-foreground/50">
              {title || 'Application'}
            </div>
            <div className="text-[10px] text-muted-foreground/30">
              App embedding will be available in a future update
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center space-y-2">
        <Monitor className="h-8 w-8 mx-auto text-green-400/20" />
        <div className="text-xs text-muted-foreground/40">
          {title || 'Application Panel'}
        </div>
        <div className="text-[10px] text-muted-foreground/25">
          {appId ? `App ID: ${appId}` : 'No application configured'}
        </div>
      </div>
    </div>
  )
}
