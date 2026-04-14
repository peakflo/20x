import { useCallback, useRef, useState, useEffect } from 'react'
import {
  useCanvasStore,
  calculateSnap,
  type CanvasPanelData,
} from '@/stores/canvas-store'
import { X, Link, Maximize2, Minimize2 } from 'lucide-react'
import { TaskPanelContent } from './TaskPanelContent'
import { TranscriptPanelContent } from './TranscriptPanelContent'
import { AppPanelContent } from './AppPanelContent'
import { WebPagePanelContent } from './WebPagePanelContent'
import { TerminalPanelContent } from './TerminalPanelContent'

interface CanvasPanelProps {
  panel: CanvasPanelData
  zoom: number
}

/**
 * A positioned, draggable, resizable floating panel on the infinite canvas.
 * Handles: drag to reposition, click-to-front z-index, close, resize, connect.
 */
export function CanvasPanel({ panel, zoom }: CanvasPanelProps) {
  const bringToFront = useCanvasStore((s) => s.bringToFront)
  const updatePanel = useCanvasStore((s) => s.updatePanel)
  const removePanel = useCanvasStore((s) => s.removePanel)
  const panels = useCanvasStore((s) => s.panels)
  const setDraggingPanelId = useCanvasStore((s) => s.setDraggingPanelId)
  const setSnapGuides = useCanvasStore((s) => s.setSnapGuides)
  const connectingFromId = useCanvasStore((s) => s.connectingFromId)
  const setConnectingFromId = useCanvasStore((s) => s.setConnectingFromId)
  const addEdge = useCanvasStore((s) => s.addEdge)

  const panelRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const [isCollapsed, setIsCollapsed] = useState(false)
  const dragStart = useRef({ x: 0, y: 0, panelX: 0, panelY: 0 })
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0 })

  const isConnectTarget = connectingFromId !== null && connectingFromId !== panel.id

  // ── Drag handling ─────────────────────────────────────────
  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      bringToFront(panel.id)
      setIsDragging(true)
      setDraggingPanelId(panel.id)
      dragStart.current = {
        x: e.clientX,
        y: e.clientY,
        panelX: panel.x,
        panelY: panel.y,
      }
    },
    [bringToFront, panel.id, panel.x, panel.y, setDraggingPanelId]
  )

  useEffect(() => {
    if (!isDragging) return

    const handleMove = (e: MouseEvent) => {
      const dx = (e.clientX - dragStart.current.x) / zoom
      const dy = (e.clientY - dragStart.current.y) / zoom
      const newX = dragStart.current.panelX + dx
      const newY = dragStart.current.panelY + dy

      // Calculate snap against other panels
      const otherPanels = panels.filter((p) => p.id !== panel.id)
      const { x: snappedX, y: snappedY, guides } = calculateSnap(
        { x: newX, y: newY, width: panel.width, height: panel.height },
        otherPanels
      )

      updatePanel(panel.id, { x: snappedX, y: snappedY })
      setSnapGuides(guides)
    }

    const handleUp = () => {
      setIsDragging(false)
      setDraggingPanelId(null)
      setSnapGuides([])
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [isDragging, panel.id, panel.width, panel.height, panels, zoom, updatePanel, setDraggingPanelId, setSnapGuides])

  // ── Resize handling ───────────────────────────────────────
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      bringToFront(panel.id)
      setIsResizing(true)
      resizeStart.current = {
        x: e.clientX,
        y: e.clientY,
        w: panel.width,
        h: panel.height,
      }
    },
    [bringToFront, panel.id, panel.width, panel.height]
  )

  useEffect(() => {
    if (!isResizing) return

    const handleMove = (e: MouseEvent) => {
      const dx = (e.clientX - resizeStart.current.x) / zoom
      const dy = (e.clientY - resizeStart.current.y) / zoom
      const minW = panel.minWidth ?? 200
      const minH = panel.minHeight ?? 150
      updatePanel(panel.id, {
        width: Math.max(minW, resizeStart.current.w + dx),
        height: Math.max(minH, resizeStart.current.h + dy),
      })
    }

    const handleUp = () => setIsResizing(false)

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [isResizing, panel.id, panel.minWidth, panel.minHeight, zoom, updatePanel])

  // ── Click handling ────────────────────────────────────────
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // If we're in connect mode and clicking a target panel, create edge
      if (isConnectTarget && connectingFromId) {
        e.preventDefault()
        e.stopPropagation()
        addEdge(connectingFromId, panel.id)
        setConnectingFromId(null)
        return
      }
      bringToFront(panel.id)
    },
    [bringToFront, panel.id, isConnectTarget, connectingFromId, addEdge, setConnectingFromId]
  )

  // ── Connect mode ──────────────────────────────────────────
  const handleConnect = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (connectingFromId === panel.id) {
        setConnectingFromId(null)
      } else {
        setConnectingFromId(panel.id)
      }
    },
    [connectingFromId, panel.id, setConnectingFromId]
  )

  // ── Close ─────────────────────────────────────────────────
  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      removePanel(panel.id)
    },
    [removePanel, panel.id]
  )

  // ── Toggle collapse ───────────────────────────────────────
  const handleToggleCollapse = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      setIsCollapsed((prev) => !prev)
    },
    []
  )

  // ── Panel type styling ────────────────────────────────────
  const TYPE_CONFIG: Record<string, { label: string; color: string; border: string }> = {
    task: { label: 'Task', color: 'bg-blue-500/20 text-blue-400', border: 'border-blue-500/20' },
    transcript: { label: 'Transcript', color: 'bg-purple-500/20 text-purple-400', border: 'border-purple-500/20' },
    app: { label: 'App', color: 'bg-green-500/20 text-green-400', border: 'border-green-500/20' },
    webpage: { label: 'Web', color: 'bg-cyan-500/20 text-cyan-400', border: 'border-cyan-500/20' },
    terminal: { label: 'Terminal', color: 'bg-amber-500/20 text-amber-400', border: 'border-amber-500/20' },
  }
  const cfg = TYPE_CONFIG[panel.type] ?? { label: 'Panel', color: 'bg-muted/30 text-muted-foreground', border: 'border-border/50' }
  const typeLabel = cfg.label
  const typeColor = cfg.color
  const borderAccent = cfg.border

  const isConnecting = connectingFromId === panel.id

  return (
    <div
      ref={panelRef}
      data-canvas-panel="true"
      onMouseDown={handleMouseDown}
      className={`absolute rounded-xl border bg-[#161b22] shadow-2xl flex flex-col overflow-hidden select-none transition-shadow duration-150 ${borderAccent} ${
        isDragging ? 'shadow-indigo-500/10 ring-1 ring-indigo-500/20' : ''
      } ${isConnectTarget ? 'ring-1 ring-indigo-400/40 cursor-crosshair' : ''} ${
        isConnecting ? 'ring-2 ring-indigo-500/50' : ''
      }`}
      style={{
        left: panel.x,
        top: panel.y,
        width: panel.width,
        height: isCollapsed ? 'auto' : panel.height,
        zIndex: panel.zIndex,
        minWidth: panel.minWidth ?? 200,
        minHeight: isCollapsed ? undefined : (panel.minHeight ?? 150),
      }}
    >
      {/* Title bar — drag handle */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b border-border/30 bg-[#0d1117]/60 flex-shrink-0 cursor-grab active:cursor-grabbing group"
        onMouseDown={handleDragStart}
      >
        <span
          className={`text-[10px] font-medium uppercase px-1.5 py-0.5 rounded ${typeColor}`}
        >
          {typeLabel}
        </span>
        <span className="text-xs text-foreground truncate flex-1 font-medium">
          {panel.title}
        </span>

        {/* Panel actions — visible on hover */}
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
          {/* Connect button */}
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleConnect}
            className={`h-5 w-5 rounded flex items-center justify-center transition-colors ${
              isConnecting
                ? 'bg-indigo-500/20 text-indigo-400'
                : 'hover:bg-white/10 text-muted-foreground/50 hover:text-muted-foreground'
            }`}
            title={isConnecting ? 'Cancel connection' : 'Connect to another panel'}
          >
            <Link className="h-3 w-3" />
          </button>

          {/* Collapse/expand */}
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleToggleCollapse}
            className="h-5 w-5 rounded flex items-center justify-center hover:bg-white/10 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            title={isCollapsed ? 'Expand' : 'Collapse'}
          >
            {isCollapsed ? (
              <Maximize2 className="h-3 w-3" />
            ) : (
              <Minimize2 className="h-3 w-3" />
            )}
          </button>

          {/* Close button */}
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleClose}
            className="h-5 w-5 rounded flex items-center justify-center hover:bg-red-500/20 text-muted-foreground/50 hover:text-red-400 transition-colors"
            title="Close panel"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Content area */}
      {!isCollapsed && (
        <div className={`flex-1 overflow-hidden min-h-0 ${panel.type === 'task' || panel.type === 'transcript' || panel.type === 'webpage' || panel.type === 'terminal' || (panel.type === 'app' && panel.refId) ? '' : 'p-3 overflow-auto'}`}>
          <PanelContent panel={panel} />
        </div>
      )}

      {/* Resize handle (bottom-right corner) */}
      {!isCollapsed && (
        <div
          onMouseDown={handleResizeStart}
          className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize group/resize"
        >
          <svg
            className="absolute bottom-1 right-1 text-muted-foreground/20 group-hover/resize:text-muted-foreground/50 transition-colors"
            width="8"
            height="8"
            viewBox="0 0 8 8"
          >
            <path d="M 6 0 L 8 0 L 8 2 Z" fill="currentColor" />
            <path d="M 3 3 L 8 3 L 8 5 L 5 5 L 5 8 L 3 8 Z" fill="currentColor" />
            <path d="M 0 6 L 2 6 L 2 8 L 0 8 Z" fill="currentColor" />
          </svg>
        </div>
      )}
    </div>
  )
}

// ── Panel content router ────────────────────────────────────

function PanelContent({ panel }: { panel: CanvasPanelData }) {
  if (panel.type === 'task' && panel.refId) {
    return <TaskPanelContent taskId={panel.refId} />
  }
  if (panel.type === 'transcript' && panel.refId) {
    return <TranscriptPanelContent taskId={panel.refId} />
  }
  if (panel.type === 'app') {
    return <AppPanelContent appId={panel.refId} title={panel.title} />
  }
  if (panel.type === 'webpage') {
    return <WebPagePanelContent panelId={panel.id} url={panel.url} title={panel.title} />
  }
  if (panel.type === 'terminal') {
    return <TerminalPanelContent terminalId={panel.id} />
  }
  return (
    <div className="flex items-center justify-center h-full text-muted-foreground/50 text-xs">
      Panel content will appear here
    </div>
  )
}
