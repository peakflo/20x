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
  /**
   * When provided, the description becomes inline-editable. Tapping the
   * description (or the "Add description" placeholder when empty) enters
   * edit mode; Save commits the new value via this callback.
   */
  onSave?: (description: string) => void | Promise<void>
  /** Placeholder shown when description is empty and `onSave` is provided. */
  placeholder?: string
}

export function CollapsibleDescription({
  taskId,
  description,
  size = 'sm',
  className,
  onSave,
  placeholder = 'Add description...'
}: CollapsibleDescriptionProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [needsCollapse, setNeedsCollapse] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(description)
  const [saving, setSaving] = useState(false)
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY_PREFIX + taskId) === '1'
    } catch {
      return false
    }
  })

  const editable = typeof onSave === 'function'

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

  // Keep draft synced with prop when not editing
  useEffect(() => {
    if (!isEditing) setDraft(description)
  }, [description, isEditing])

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus()
      const len = textareaRef.current.value.length
      textareaRef.current.setSelectionRange(len, len)
    }
  }, [isEditing])

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

  const beginEdit = useCallback(() => {
    if (!editable) return
    setDraft(description)
    setIsEditing(true)
  }, [editable, description])

  const cancelEdit = useCallback(() => {
    setDraft(description)
    setIsEditing(false)
  }, [description])

  const commitEdit = useCallback(async () => {
    if (!onSave) return
    const next = draft.trim() === '' ? '' : draft
    if (next === description) {
      setIsEditing(false)
      return
    }
    setSaving(true)
    try {
      await onSave(next)
      setIsEditing(false)
    } catch (err) {
      console.error('[CollapsibleDescription] Failed to save description:', err)
    } finally {
      setSaving(false)
    }
  }, [draft, description, onSave])

  const isCollapsed = needsCollapse && !expanded

  // Edit mode
  if (isEditing) {
    return (
      <div className={className} data-testid="description-edit-form">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              cancelEdit()
            } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              void commitEdit()
            }
          }}
          rows={Math.min(12, Math.max(4, draft.split('\n').length + 1))}
          placeholder={placeholder}
          disabled={saving}
          className="w-full min-h-[96px] rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring/30 resize-y disabled:opacity-60"
          data-testid="description-edit-textarea"
        />
        <div className="mt-2 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={cancelEdit}
            disabled={saving}
            className="text-xs text-muted-foreground active:opacity-60 px-3 py-1.5 rounded-md hover:bg-accent disabled:opacity-50"
            data-testid="description-edit-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={commitEdit}
            disabled={saving}
            className="text-xs bg-primary text-primary-foreground hover:bg-primary/90 active:opacity-60 rounded-md px-3 py-1.5 disabled:opacity-60"
            data-testid="description-edit-save"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    )
  }

  // Empty + editable: show placeholder button
  if (editable && !description) {
    return (
      <button
        type="button"
        onClick={beginEdit}
        className={`${className ?? ''} flex items-center gap-1.5 text-xs text-muted-foreground/70 hover:text-foreground active:opacity-60`}
        data-testid="description-add-placeholder"
      >
        <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14" />
          <path d="M12 5v14" />
        </svg>
        {placeholder}
      </button>
    )
  }

  return (
    <div className={className}>
      <div className="relative">
        <div
          ref={contentRef}
          className={`overflow-hidden transition-all duration-200 ${editable ? 'cursor-text rounded-md active:bg-accent/30' : ''}`}
          style={isCollapsed ? { maxHeight: `${COLLAPSED_MAX_HEIGHT}px` } : undefined}
          onClick={editable ? beginEdit : undefined}
          role={editable ? 'button' : undefined}
          tabIndex={editable ? 0 : undefined}
          onKeyDown={editable ? (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              beginEdit()
            }
          } : undefined}
          data-testid={editable ? 'description-editable-content' : undefined}
        >
          <Markdown size={size}>{description}</Markdown>
        </div>
        {editable && (
          <button
            type="button"
            onClick={beginEdit}
            className="absolute top-0 right-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent active:opacity-60"
            aria-label="Edit description"
            data-testid="description-edit-trigger"
          >
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
              <path d="m15 5 4 4"/>
            </svg>
          </button>
        )}
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
