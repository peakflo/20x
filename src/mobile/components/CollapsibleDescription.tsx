import { useState, useRef, useEffect, useCallback } from 'react'
import { Markdown } from '@/components/ui/Markdown'

const COLLAPSED_LINE_COUNT = 5
const LINE_HEIGHT_PX = 20
const COLLAPSED_MAX_HEIGHT = COLLAPSED_LINE_COUNT * LINE_HEIGHT_PX
const STORAGE_KEY_PREFIX = '20x-desc-expanded-'

interface CollapsibleDescriptionProps {
  taskId: string
  description: string
  size?: 'xs' | 'sm' | 'base'
  className?: string
}

export function CollapsibleDescription({ taskId, description, size = 'sm', className }: CollapsibleDescriptionProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [needsCollapse, setNeedsCollapse] = useState(false)
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY_PREFIX + taskId) === '1'
    } catch {
      return false
    }
  })

  const measureContent = useCallback(() => {
    if (contentRef.current) {
      const scrollHeight = contentRef.current.scrollHeight
      setNeedsCollapse(scrollHeight > COLLAPSED_MAX_HEIGHT + 8)
    }
  }, [])

  useEffect(() => {
    measureContent()
  }, [description, measureContent])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
    window.addEventListener('resize', measureContent)
    return () => window.removeEventListener('resize', measureContent)
  }, [measureContent])

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev
      try {
        if (next) {
          localStorage.setItem(STORAGE_KEY_PREFIX + taskId, '1')
        } else {
          localStorage.removeItem(STORAGE_KEY_PREFIX + taskId)
        }
      } catch { /* ignore storage errors */ }
      return next
    })
  }, [taskId])

  const isCollapsed = needsCollapse && !expanded

  return (
    <div className={className}>
      <div
        ref={contentRef}
        className="overflow-hidden transition-all duration-200"
        style={isCollapsed ? { maxHeight: `${COLLAPSED_MAX_HEIGHT}px` } : undefined}
      >
        <Markdown size={size}>{description}</Markdown>
      </div>
      {needsCollapse && (
        <button
          onClick={toggleExpanded}
          className="flex items-center gap-1 mt-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? (
            <>
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m18 15-6-6-6 6"/>
              </svg>
              Show less
            </>
          ) : (
            <>
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m6 9 6 6 6-6"/>
              </svg>
              Show more
            </>
          )}
        </button>
      )}
    </div>
  )
}
