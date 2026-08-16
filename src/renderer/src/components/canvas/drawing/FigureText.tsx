import { memo, useEffect, useRef } from 'react'
import type { TextFigure } from './types'
import { fontCssFor } from './types'

interface FigureTextProps {
  obj: TextFigure
  /** True while this figure is in contentEditable mode. */
  isEditing: boolean
  /** True when the select tool is active (figure is clickable). */
  interactive: boolean
  onCommitText: (id: string, text: string) => void
}

/**
 * Memoized text figure — an absolutely-positioned div in canvas space (it
 * lives inside the CSS-transformed canvas layer, so it scales with zoom for
 * free). While `isEditing`, the inner div becomes contentEditable: the DOM
 * owns the text until blur/Escape commits it via `onCommitText` (single store
 * write, same imperative pattern as the canvas gestures).
 *
 * The outer div carries `data-figure-id` for DrawingLayer's event delegation.
 */
export const FigureText = memo(function FigureText({
  obj,
  isEditing,
  interactive,
  onCommitText,
}: FigureTextProps) {
  const editableRef = useRef<HTMLDivElement>(null)

  // Enter editing: hand the DOM the current text, focus it, select all.
  useEffect(() => {
    if (!isEditing) return
    const el = editableRef.current
    if (!el) return
    el.textContent = obj.text
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)

    return () => {
      // Editing ended externally (tool switch, figure removed) while this div
      // still holds focus — commit what the user typed instead of losing it.
      if (document.activeElement === el) {
        onCommitText(obj.id, readEditableText(el))
      }
    }
  }, [isEditing])

  const commit = () => {
    const el = editableRef.current
    if (!el) return
    onCommitText(obj.id, readEditableText(el))
  }

  return (
    <div
      data-figure-id={obj.id}
      className="absolute"
      style={{
        left: obj.x,
        top: obj.y,
        width: obj.width,
        height: obj.height,
        opacity: obj.opacity,
        pointerEvents: interactive ? 'auto' : 'none',
        cursor: isEditing ? 'text' : 'move',
        // While editing, show a visible box so an (empty) text figure is
        // obvious even when the text color is close to the canvas background.
        border: isEditing ? '1.5px dashed rgba(30,150,235,0.9)' : '1.5px solid transparent',
        background: isEditing ? 'rgba(30,150,235,0.06)' : 'transparent',
        borderRadius: 4,
      }}
    >
      <div
        ref={editableRef}
        contentEditable={isEditing}
        suppressContentEditableWarning
        spellCheck={false}
        onBlur={isEditing ? commit : undefined}
        onKeyDown={
          isEditing
            ? (e) => {
                // Keep canvas shortcuts (Delete, tool keys…) away from typing.
                e.stopPropagation()
                if (e.key === 'Escape') {
                  e.preventDefault()
                  e.currentTarget.blur()
                }
              }
            : undefined
        }
        style={{
          width: '100%',
          height: '100%',
          outline: 'none',
          fontSize: obj.fontSize,
          fontFamily: fontCssFor(obj.fontFamily),
          fontWeight: obj.fontWeight,
          color: obj.stroke,
          textAlign: obj.textAlign,
          lineHeight: 1.3,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflow: 'hidden',
        }}
      >
        {isEditing ? undefined : obj.text}
      </div>
    </div>
  )
})

/** Read the current text of a contentEditable div (innerText where available). */
function readEditableText(el: HTMLElement): string {
  const raw = el.innerText ?? el.textContent ?? ''
  return raw.replace(/\u00a0/g, ' ')
}
