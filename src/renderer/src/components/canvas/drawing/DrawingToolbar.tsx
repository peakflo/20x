import { useEffect, useRef, useState } from 'react'
import {
  MousePointer2,
  Square,
  Circle,
  Minus,
  MoveUpRight,
  Type,
  Image,
  PaintBucket,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDrawingStore, type FigureUpdates } from '@/stores/drawing-store'
import {
  STROKE_WIDTHS,
  FONT_SIZES,
  FONT_FAMILIES,
  STROKE_COLORS,
  FILL_OPTIONS,
  type DrawingTool,
  type DrawingObject,
  type DrawingToolOptions,
} from './types'

/**
 * Which figure fields a given style option drives. Returns the update to apply
 * to a figure, or null when the option doesn't apply to that figure type.
 * Shared by the toolbar (style controls) and the properties panel.
 */
export function styleUpdatesFor<K extends keyof DrawingToolOptions>(
  key: K,
  value: DrawingToolOptions[K],
  obj: DrawingObject
): FigureUpdates | null {
  // `value` is typed as `DrawingToolOptions[K]`; the switch narrows `key` but
  // not the indexed type of `value`, so each branch casts to the concrete type
  // (safe — the generic signature already guarantees `value` matches `key`).
  switch (key) {
    case 'stroke':
      // Text uses `stroke` as its text color, so it applies to every figure.
      return { stroke: value as string }
    case 'strokeWidth':
      if (obj.type === 'text' || obj.type === 'image') return null
      return { strokeWidth: value as number }
    case 'fill':
      if (obj.type !== 'rectangle' && obj.type !== 'ellipse') return null
      return { fill: value as string | null }
    case 'fontSize':
      if (obj.type !== 'text') return null
      return { fontSize: value as number }
    case 'fontFamily':
      if (obj.type !== 'text') return null
      return { fontFamily: value as string }
    case 'fontWeight':
      if (obj.type !== 'text') return null
      return { fontWeight: value as number }
  }
}

interface ToolDef {
  tool: DrawingTool
  label: string
  shortcut: string
  icon: LucideIcon
}

const TOOLS: ToolDef[] = [
  { tool: 'select', label: 'Select', shortcut: 'V', icon: MousePointer2 },
  { tool: 'rectangle', label: 'Rectangle', shortcut: 'R', icon: Square },
  { tool: 'ellipse', label: 'Ellipse', shortcut: 'O', icon: Circle },
  { tool: 'line', label: 'Line', shortcut: 'L', icon: Minus },
  { tool: 'arrow', label: 'Arrow', shortcut: 'A', icon: MoveUpRight },
  { tool: 'text', label: 'Text', shortcut: 'T', icon: Type },
  { tool: 'image', label: 'Image', shortcut: 'I', icon: Image },
]

/**
 * Floating drawing toolbar (bottom-center, canvas screen only).
 *
 * Tool buttons switch `activeTool`; the style controls write to `toolOptions`
 * (affecting the next figure) and, when a figure is selected, live-update the
 * selection via `updateObject`. Styled like the existing canvas HUD.
 */
export function DrawingToolbar() {
  const activeTool = useDrawingStore((s) => s.activeTool)
  const setTool = useDrawingStore((s) => s.setTool)
  const toolOptions = useDrawingStore((s) => s.toolOptions)
  const setToolOption = useDrawingStore((s) => s.setToolOption)

  const [showColor, setShowColor] = useState(false)
  const [showFill, setShowFill] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Close the swatch popovers on outside click.
  useEffect(() => {
    if (!showColor && !showFill) return
    const handleClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setShowColor(false)
        setShowFill(false)
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowColor(false)
        setShowFill(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [showColor, showFill])

  /** Update toolOptions and live-apply to the current selection. */
  const applyStyle = <K extends keyof DrawingToolOptions>(key: K, value: DrawingToolOptions[K]) => {
    setToolOption(key, value)
    const { selectedIds, objects, updateObject } = useDrawingStore.getState()
    for (const id of selectedIds) {
      const obj = objects.find((o) => o.id === id)
      if (!obj) continue
      const updates = styleUpdatesFor(key, value, obj)
      if (updates) updateObject(id, updates)
    }
  }

  return (
    <div
      ref={rootRef}
      className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 bg-[var(--canvas-toolbar)] backdrop-blur-sm border border-border/40 rounded-xl p-1 shadow-lg"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* ── Tools ── */}
      {TOOLS.map(({ tool, label, shortcut, icon: Icon }) => {
        const active = activeTool === tool
        return (
          <button
            key={tool}
            type="button"
            title={`${label} (${shortcut})`}
            onClick={() => setTool(tool)}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
              active
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            )}
          >
            <Icon className="h-4 w-4" />
          </button>
        )
      })}

      <div className="w-px h-5 bg-border/30 mx-1" />

      {/* ── Stroke color ── */}
      <div className="relative">
        <button
          type="button"
          title="Stroke color"
          onClick={() => {
            setShowColor((v) => !v)
            setShowFill(false)
          }}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <span
            className="h-4 w-4 rounded-full border border-border/50"
            style={{ background: toolOptions.stroke }}
          />
        </button>
        {showColor && (
          <SwatchPopover>
            {STROKE_COLORS.map((color) => (
              <SwatchButton
                key={color}
                color={color}
                active={toolOptions.stroke === color}
                onClick={() => {
                  applyStyle('stroke', color)
                  setShowColor(false)
                }}
              />
            ))}
          </SwatchPopover>
        )}
      </div>

      {/* ── Stroke width ── */}
      <div className="flex items-center gap-0.5 rounded-lg px-0.5">
        {STROKE_WIDTHS.map((w) => {
          const active = toolOptions.strokeWidth === w
          return (
            <button
              key={w}
              type="button"
              title={`Stroke width ${w}`}
              onClick={() => applyStyle('strokeWidth', w)}
              className={cn(
                'flex h-8 w-6 items-center justify-center rounded-md transition-colors',
                active
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              )}
            >
              <span
                className="w-4 rounded-full"
                style={{ height: `${Math.min(6, w)}px`, background: 'currentColor' }}
              />
            </button>
          )
        })}
      </div>

      {/* ── Fill ── */}
      <div className="relative">
        <button
          type="button"
          title="Fill"
          onClick={() => {
            setShowFill((v) => !v)
            setShowColor(false)
          }}
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
            toolOptions.fill
              ? 'text-accent-foreground bg-accent'
              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
          )}
        >
          <PaintBucket className="h-4 w-4" />
        </button>
        {showFill && (
          <SwatchPopover>
            {FILL_OPTIONS.map((fill) => (
              <SwatchButton
                key={fill ?? 'none'}
                color={fill}
                active={toolOptions.fill === fill}
                onClick={() => {
                  applyStyle('fill', fill)
                  setShowFill(false)
                }}
              />
            ))}
          </SwatchPopover>
        )}
      </div>

      <div className="w-px h-5 bg-border/30 mx-1" />

      {/* ── Font size ── */}
      <select
        value={toolOptions.fontSize}
        onChange={(e) => applyStyle('fontSize', Number(e.target.value))}
        title="Font size"
        className="h-8 rounded-lg bg-transparent px-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus:outline-none cursor-pointer"
      >
        {FONT_SIZES.map((size) => (
          <option key={size} value={size} className="text-foreground">
            {size}px
          </option>
        ))}
      </select>

      {/* ── Font family ── */}
      <select
        value={toolOptions.fontFamily}
        onChange={(e) => applyStyle('fontFamily', e.target.value)}
        title="Font family"
        className="h-8 rounded-lg bg-transparent px-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus:outline-none cursor-pointer"
      >
        {FONT_FAMILIES.map((family) => (
          <option key={family.id} value={family.id} className="text-foreground">
            {family.label}
          </option>
        ))}
      </select>
    </div>
  )
}

// ── Swatch popover + button ────────────────────────────────

function SwatchPopover({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 flex flex-wrap items-center gap-1.5 w-44 p-2 bg-popover border border-border/50 rounded-xl shadow-2xl"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  )
}

function SwatchButton({
  color,
  active,
  onClick,
}: {
  color: string | null
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={color ?? 'No fill'}
      className={cn(
        'h-6 w-6 rounded-full border transition-transform hover:scale-110',
        active ? 'border-primary ring-2 ring-primary/40' : 'border-border/50'
      )}
      style={{
        background: color ?? 'transparent',
        backgroundImage:
          color === null
            ? 'linear-gradient(45deg, transparent 45%, #ef4444 45%, #ef4444 55%, transparent 55%)'
            : undefined,
      }}
    />
  )
}
