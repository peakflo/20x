/**
 * Mermaid Diagram Renderer
 *
 * Renders ```mermaid fenced blocks as SVG diagrams. Mermaid is loaded lazily
 * (dynamic import) so the ~1.5MB library is only fetched when a diagram is
 * actually present. Falls back to the raw source code when parsing fails.
 */

import { memo, useEffect, useRef, useState } from 'react'
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
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
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
    setError(null)

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
        if (cancelled || !result || !containerRef.current) return
        containerRef.current.innerHTML = result.svg
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to render diagram')
      })

    return () => {
      cancelled = true
    }
  }, [code, theme])

  if (error) {
    return (
      <div className={cn('bg-muted rounded', className)}>
        <pre className="overflow-x-auto p-3 font-mono text-xs whitespace-pre text-foreground">{code}</pre>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label="Mermaid diagram"
      className={cn('mermaid-diagram flex justify-center overflow-x-auto rounded bg-muted', className)}
    />
  )
})
