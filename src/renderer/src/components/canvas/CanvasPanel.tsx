import { useCallback, useRef } from 'react'
import { useCanvasStore, type CanvasPanelData } from '@/stores/canvas-store'

interface CanvasPanelProps {
  panel: CanvasPanelData
  children?: React.ReactNode
}

/**
 * A positioned, resizable floating panel rendered on the infinite canvas.
 * Handles z-index layering via click-to-front.
 * Drag and resize logic will be added in the sibling subtask (panel interactions).
 */
export function CanvasPanel({ panel, children }: CanvasPanelProps) {
  const bringToFront = useCanvasStore((s) => s.bringToFront)
  const panelRef = useRef<HTMLDivElement>(null)

  const handleMouseDown = useCallback(
    (_e: React.MouseEvent) => {
      // Bring panel to front on any click
      bringToFront(panel.id)
    },
    [bringToFront, panel.id]
  )

  const typeLabel =
    panel.type === 'task'
      ? 'Task'
      : panel.type === 'transcript'
        ? 'Transcript'
        : panel.type === 'app'
          ? 'App'
          : 'Panel'

  const typeColor =
    panel.type === 'task'
      ? 'bg-blue-500/20 text-blue-400'
      : panel.type === 'transcript'
        ? 'bg-purple-500/20 text-purple-400'
        : panel.type === 'app'
          ? 'bg-green-500/20 text-green-400'
          : 'bg-muted/30 text-muted-foreground'

  return (
    <div
      ref={panelRef}
      onMouseDown={handleMouseDown}
      className="absolute rounded-xl border border-border/50 bg-[#161b22] shadow-2xl flex flex-col overflow-hidden select-none"
      style={{
        left: panel.x,
        top: panel.y,
        width: panel.width,
        height: panel.height,
        zIndex: panel.zIndex,
        minWidth: panel.minWidth ?? 200,
        minHeight: panel.minHeight ?? 150,
      }}
    >
      {/* Title bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/30 bg-[#0d1117]/60 flex-shrink-0">
        <span className={`text-[10px] font-medium uppercase px-1.5 py-0.5 rounded ${typeColor}`}>
          {typeLabel}
        </span>
        <span className="text-xs text-foreground truncate flex-1 font-medium">
          {panel.title}
        </span>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-auto p-3">
        {children || (
          <div className="flex items-center justify-center h-full text-muted-foreground/50 text-xs">
            Panel content will appear here
          </div>
        )}
      </div>
    </div>
  )
}
