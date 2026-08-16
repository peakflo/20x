import { BringToFront, Copy, Trash2, Bold, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDrawingStore } from '@/stores/drawing-store'
import { styleUpdatesFor } from './DrawingToolbar'
import {
  FONT_SIZES,
  FONT_FAMILIES,
  type DrawingToolOptions,
} from './types'

/**
 * Floating properties panel for the current figure selection.
 *
 * Shown only when a figure is selected (canvas screen only). Offers the
 * figure actions (bring-to-front, duplicate, delete) plus, for text figures,
 * font size / family / weight controls that live-update the selection.
 */
export function DrawingProperties() {
  const selectedIds = useDrawingStore((s) => s.selectedIds)
  const objects = useDrawingStore((s) => s.objects)
  const removeObjects = useDrawingStore((s) => s.removeObjects)
  const duplicateObject = useDrawingStore((s) => s.duplicateObject)
  const bringToFront = useDrawingStore((s) => s.bringToFront)
  const updateObject = useDrawingStore((s) => s.updateObject)

  if (selectedIds.length === 0) return null

  const selected = objects.filter((o) => selectedIds.includes(o.id))
  const firstText = selected.find((o) => o.type === 'text')

  /** Apply a style option to every selected text figure. */
  const applyToText = <K extends keyof DrawingToolOptions>(key: K, value: DrawingToolOptions[K]) => {
    for (const id of selectedIds) {
      const obj = objects.find((o) => o.id === id)
      if (obj?.type !== 'text') continue
      const updates = styleUpdatesFor(key, value, obj)
      if (updates) updateObject(id, updates)
    }
  }

  return (
    <div
      className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 bg-[var(--canvas-toolbar)] backdrop-blur-sm border border-border/40 rounded-xl p-1 shadow-lg"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="px-2 text-[11px] text-muted-foreground tabular-nums">
        {selectedIds.length} selected
      </span>

      <div className="w-px h-5 bg-border/30 mx-0.5" />

      <PropertyButton
        icon={BringToFront}
        title="Bring to front"
        onClick={() => selectedIds.forEach((id) => bringToFront(id))}
      />
      <PropertyButton
        icon={Copy}
        title="Duplicate"
        onClick={() => {
          // Duplicate the topmost-selected figure (last in the list).
          const id = selectedIds[selectedIds.length - 1]
          if (id) duplicateObject(id)
        }}
      />
      <PropertyButton
        icon={Trash2}
        title="Delete (Del)"
        danger
        onClick={() => removeObjects(selectedIds)}
      />

      {firstText && (
        <>
          <div className="w-px h-5 bg-border/30 mx-0.5" />

          <select
            value={firstText.fontSize}
            onChange={(e) => applyToText('fontSize', Number(e.target.value))}
            title="Font size"
            className="h-8 rounded-lg bg-transparent px-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus:outline-none cursor-pointer"
          >
            {FONT_SIZES.map((size) => (
              <option key={size} value={size} className="text-foreground">
                {size}px
              </option>
            ))}
          </select>

          <select
            value={firstText.fontFamily}
            onChange={(e) => applyToText('fontFamily', e.target.value)}
            title="Font family"
            className="h-8 rounded-lg bg-transparent px-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus:outline-none cursor-pointer"
          >
            {FONT_FAMILIES.map((family) => (
              <option key={family.id} value={family.id} className="text-foreground">
                {family.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            title="Bold"
            onClick={() => applyToText('fontWeight', firstText.fontWeight >= 600 ? 400 : 700)}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
              firstText.fontWeight >= 600
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            )}
          >
            <Bold className="h-4 w-4" />
          </button>
        </>
      )}
    </div>
  )
}

function PropertyButton({
  icon: Icon,
  title,
  onClick,
  danger = false,
}: {
  icon: LucideIcon
  title: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
        danger
          ? 'text-red-400 hover:bg-red-500/15 hover:text-red-300'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
      )}
    >
      <Icon className="h-4 w-4" />
    </button>
  )
}
