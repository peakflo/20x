/**
 * Mermaid Diagram Renderer
 *
 * Renders ```mermaid fenced blocks as SVG diagrams. Mermaid is loaded lazily
 * (dynamic import) so the ~1.5MB library is only fetched when a diagram is
 * actually present. Falls back to the raw source code when parsing fails.
 */

import { memo, useEffect, useState } from 'react'
import type { Mermaid } from 'mermaid'
import { cn } from '@/lib/utils'

interface MermaidDiagramProps {
  code: string
  className?: string
}

// Shared lazy import promise — mermaid is fetched at most once per session
let mermaidPromise: Promise<Mermaid> | null = null
function loadMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(m => m.default)
  }
  return mermaidPromise
}

function getSystemTheme(): 'dark' | 'default' {
  if (typeof document === 'undefined') return 'default'
  return document.documentElement.classList.contains('dark') ? 'dark' : 'default'
}

let diagramIdCounter = 0

export const MermaidDiagram = memo(function MermaidDiagram({ code, className }: MermaidDiagramProps) {
  const [rendered, setRendered] = useState<{ code: string; svg: string } | null>(null)
  const [failedCode, setFailedCode] = useState<string | null>(null)
  const [theme, setTheme] = useState(getSystemTheme)

  // Re-render when the app theme toggles (.dark class on <html>)
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const next = getSystemTheme()
      setTheme(prev => (prev === next ? prev : next))
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    const diagramId = `mermaid-diagram-${++diagramIdCounter}`
    loadMermaid()
      .then(mermaid => {
        if (cancelled) return null
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme
        })
        return mermaid.render(diagramId, code)
      })
      .then(result => {
        if (cancelled || !result) return
        setRendered({ code, svg: result.svg })
        setFailedCode(null)
      })
      .catch(() => {
        if (cancelled) return
        setFailedCode(code)
      })

    return () => {
      cancelled = true
    }
  }, [code, theme])

  if (failedCode === code) {
    return (
      <div className={cn('bg-muted rounded', className)}>
        <pre className="overflow-x-auto p-3 font-mono text-xs whitespace-pre text-foreground">{code}</pre>
      </div>
    )
  }

  // Keep the fenced source visible while Mermaid loads. Replacing the code
  // block with an empty div makes every line below it jump up and then down.
  if (rendered?.code !== code) {
    return (
      <div className={cn('bg-muted rounded', className)}>
        <pre className="overflow-x-auto font-mono text-xs whitespace-pre text-foreground">{code}</pre>
      </div>
    )
  }

  return (
    <div
      role="img"
      aria-label="Mermaid diagram"
      className={cn('mermaid-diagram flex justify-center overflow-x-auto rounded bg-muted', className)}
      dangerouslySetInnerHTML={{ __html: rendered.svg }}
    />
  )
})
