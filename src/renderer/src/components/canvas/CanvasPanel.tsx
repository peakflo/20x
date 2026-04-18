import { useCallback, useRef, useState, useEffect, memo } from 'react'
import {
  useCanvasStore,
  calculateSnap,
  type CanvasPanelData,
} from '@/stores/canvas-store'
import { X, Focus, Maximize2, Minimize2, PanelLeft, PanelRight, Columns2, Link2 } from 'lucide-react'
import type { TaskWorkspaceLayout } from '@/components/tasks/TaskWorkspace'
import { TaskPanelContent } from './TaskPanelContent'
import { TranscriptPanelContent } from './TranscriptPanelContent'
import { AppPanelContent } from './AppPanelContent'
import { WebPagePanelContent } from './WebPagePanelContent'
import { TerminalPanelContent } from './TerminalPanelContent'
import { BrowserPanelContent } from './BrowserPanelContent'

interface CanvasPanelProps {
  panel: CanvasPanelData
  zoom: number
  /** When true, the panel is off-viewport — heavy content (iframes, terminals) is hidden */
  frozen?: boolean
}

/**
 * A positioned, draggable, resizable floating panel on the infinite canvas.
 * Handles: drag to reposition, click-to-front z-index, close, resize, focus.
 *
 * Memoized so that only the panel whose data changed re-renders — prevents
 * iframes/terminals from being remounted when a *different* panel moves.
 */
export const CanvasPanel = memo(function CanvasPanel({ panel, zoom, frozen = false }: CanvasPanelProps) {
  const bringToFront = useCanvasStore((s) => s.bringToFront)
  const updatePanel = useCanvasStore((s) => s.updatePanel)
  const removePanel = useCanvasStore((s) => s.removePanel)
  const focusPanel = useCanvasStore((s) => s.focusPanel)
  const setDraggingPanelId = useCanvasStore((s) => s.setDraggingPanelId)
  const setSnapGuides = useCanvasStore((s) => s.setSnapGuides)
  // Read connectingFromId imperatively to avoid re-rendering ALL panels when it changes.
  // Only the connect button click handlers need it — not the render path.
  const setConnectingFromId = useCanvasStore((s) => s.setConnectingFromId)
  const addEdge = useCanvasStore((s) => s.addEdge)

  const panelRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [taskLayout, setTaskLayout] = useState<TaskWorkspaceLayout>('both')
  const dragStart = useRef({ x: 0, y: 0, panelX: 0, panelY: 0 })
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0 })

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

      // Read panels imperatively — avoids reactive subscription that re-renders all panels
      const otherPanels = useCanvasStore.getState().panels.filter((p) => p.id !== panel.id)
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
  }, [isDragging, panel.id, panel.width, panel.height, zoom, updatePanel, setDraggingPanelId, setSnapGuides])

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

  // ── Connect (edge drawing) ─────────────────────────────────
  // Local state tracks whether THIS panel initiated connecting — avoids global subscription
  const [isConnectingLocal, setIsConnectingLocal] = useState(false)

  const handleStartConnect = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      setConnectingFromId(panel.id)
      setIsConnectingLocal(true)
    },
    [setConnectingFromId, panel.id]
  )

  const handleCancelConnect = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      setConnectingFromId(null)
      setIsConnectingLocal(false)
    },
    [setConnectingFromId]
  )

  // Sync local state when store clears connectingFromId (Escape, background click, or edge completed)
  useEffect(() => {
    if (!isConnectingLocal) return
    const unsub = useCanvasStore.subscribe((s) => {
      if (s.connectingFromId !== panel.id) {
        setIsConnectingLocal(false)
      }
    })
    return unsub
  }, [isConnectingLocal, panel.id])

  // ── Click handling ────────────────────────────────────────
  const handleMouseDown = useCallback(
    () => {
      // Read connecting state imperatively — no subscription cost
      const connectingFrom = useCanvasStore.getState().connectingFromId
      if (connectingFrom && connectingFrom !== panel.id) {
        // Complete the edge
        const fromPanel = useCanvasStore.getState().panels.find((p) => p.id === connectingFrom)
        const isBrowserEdge = panel.type === 'browser' || fromPanel?.type === 'browser'
        addEdge(connectingFrom, panel.id, isBrowserEdge ? 'browser' : undefined)
        setConnectingFromId(null)
        return
      }
      bringToFront(panel.id)
    },
    [bringToFront, panel.id, panel.type, addEdge, setConnectingFromId]
  )

  // ── Focus (zoom-to-fit this panel) ────────────────────────
  const handleFocus = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      const canvas = panelRef.current?.closest('[data-canvas-root]') as HTMLElement | null
      if (canvas) {
        const rect = canvas.getBoundingClientRect()
        focusPanel(panel.id, rect.width, rect.height)
      }
    },
    [focusPanel, panel.id]
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
    task: { label: 'Task', color: 'bg-blue-500/20 text-blue-400', border: 'border-blue-500/40' },
    transcript: { label: 'Transcript', color: 'bg-purple-500/20 text-purple-400', border: 'border-purple-500/40' },
    app: { label: 'App', color: 'bg-green-500/20 text-green-400', border: 'border-green-500/40' },
    webpage: { label: 'Web', color: 'bg-cyan-500/20 text-cyan-400', border: 'border-cyan-500/40' },
    terminal: { label: 'Terminal', color: 'bg-amber-500/20 text-amber-400', border: 'border-amber-500/50' },
    browser: { label: 'Browser', color: 'bg-orange-500/20 text-orange-400', border: 'border-orange-500/40' },
  }
  const cfg = TYPE_CONFIG[panel.type] ?? { label: 'Panel', color: 'bg-muted/30 text-muted-foreground', border: 'border-border/50' }

  return (
    <div
      ref={panelRef}
      data-canvas-panel="true"
      onMouseDown={handleMouseDown}
      className={`absolute rounded-xl border bg-[#1a2030] shadow-2xl flex flex-col overflow-hidden select-none transition-shadow duration-150 ${cfg.border} ${
        isDragging ? 'shadow-indigo-500/10 ring-1 ring-indigo-500/30' : ''
      } ${isConnectingLocal ? 'ring-2 ring-orange-500/50' : ''}`}
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
        className="flex items-center gap-2 px-3 py-2 border-b border-border/40 bg-[#141a26] flex-shrink-0 cursor-grab active:cursor-grabbing group"
        onMouseDown={handleDragStart}
      >
        <span
          className={`text-[10px] font-medium uppercase px-1.5 py-0.5 rounded ${cfg.color}`}
        >
          {cfg.label}
        </span>
        <span className="text-xs text-foreground truncate flex-1 font-medium">
          {panel.title}
        </span>

        {/* Task layout toggle — always visible for task panels */}
        {panel.type === 'task' && (
          <div className="flex items-center gap-0.5 mr-1">
            {([
              { key: 'task-only' as const, icon: PanelLeft, label: 'Task details only' },
              { key: 'both' as const, icon: Columns2, label: 'Task + Transcript' },
              { key: 'transcript-only' as const, icon: PanelRight, label: 'Transcript only' },
            ]).map(({ key, icon: Icon, label }) => (
              <button
                key={key}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setTaskLayout(key)}
                className={`h-5 w-5 rounded flex items-center justify-center transition-colors ${
                  taskLayout === key
                    ? 'bg-white/15 text-foreground'
                    : 'text-muted-foreground/40 hover:text-muted-foreground hover:bg-white/10'
                }`}
                title={label}
              >
                <Icon className="h-3 w-3" />
              </button>
            ))}
          </div>
        )}

        {/* Panel actions — visible on hover (or always when connecting) */}
        <div className={`flex items-center gap-0.5 transition-opacity duration-150 ${isConnectingLocal ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
          {/* Connect / link to another panel */}
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={isConnectingLocal ? handleCancelConnect : handleStartConnect}
            className={`h-5 w-5 rounded flex items-center justify-center transition-colors ${
              isConnectingLocal
                ? 'bg-orange-500/20 text-orange-400 ring-1 ring-orange-500/40'
                : 'hover:bg-white/10 text-muted-foreground/50 hover:text-muted-foreground'
            }`}
            title={isConnectingLocal ? 'Cancel connecting (click another panel to connect)' : 'Connect to another panel'}
          >
            <Link2 className="h-3 w-3" />
          </button>

          {/* Focus / zoom-to-fit button */}
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleFocus}
            className="h-5 w-5 rounded flex items-center justify-center hover:bg-white/10 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            title="Focus panel (zoom to fit)"
          >
            <Focus className="h-3 w-3" />
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
        <div
          className={`flex-1 overflow-hidden min-h-0 ${panel.type === 'task' || panel.type === 'transcript' || panel.type === 'webpage' || panel.type === 'terminal' || panel.type === 'browser' || (panel.type === 'app' && panel.refId) ? '' : 'p-3 overflow-auto'}`}
          style={frozen ? { visibility: 'hidden' } : undefined}
        >
          <MemoizedPanelContent
            type={panel.type}
            id={panel.id}
            refId={panel.refId}
            url={panel.url}
            title={panel.title}
            taskLayout={taskLayout}
            browserSessionId={panel.browserSessionId}
            streamPort={panel.streamPort}
          />
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
})

// ── Memoized panel content router ──────────────────────────
// Only re-renders when the content-relevant props change (type, refId, url, id).
// Position/size/zIndex changes do NOT cause content to remount.

interface PanelContentProps {
  type: string
  id: string
  refId?: string
  url?: string
  title: string
  taskLayout?: TaskWorkspaceLayout
  browserSessionId?: string
  streamPort?: number
}

const MemoizedPanelContent = memo(function PanelContent({ type, id, refId, url, title, taskLayout, browserSessionId, streamPort }: PanelContentProps) {
  if (type === 'task' && refId) {
    return <TaskPanelContent taskId={refId} panelLayout={taskLayout} />
  }
  if (type === 'transcript' && refId) {
    return <TranscriptPanelContent taskId={refId} />
  }
  if (type === 'app') {
    return <AppPanelContent appId={refId} title={title} />
  }
  if (type === 'webpage') {
    return <WebPagePanelContent panelId={id} url={url} title={title} />
  }
  if (type === 'terminal') {
    return <TerminalPanelContent terminalId={id} />
  }
  if (type === 'browser') {
    return <BrowserPanelContent panelId={id} url={url} sessionName={browserSessionId} streamPort={streamPort} />
  }
  return (
    <div className="flex items-center justify-center h-full text-muted-foreground/50 text-xs">
      Panel content will appear here
    </div>
  )
})
