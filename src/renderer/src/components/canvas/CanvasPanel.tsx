import { useCallback, useRef, useState, useEffect, memo, useMemo } from 'react'
import {
  useCanvasStore,
  calculateSnap,
  detectProximityEdge,
  DEFAULT_PANEL_WIDTH,
  DEFAULT_PANEL_HEIGHT,
  type CanvasPanelData,
} from '@/stores/canvas-store'
import { X, Focus, Maximize2, Minimize2, PanelLeft, PanelRight, Columns2, Globe } from 'lucide-react'
import type { TaskWorkspaceLayout } from '@/components/tasks/TaskWorkspace'
import { useTaskStore } from '@/stores/task-store'
import { TaskStatus } from '@/types'
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
  /** 0-based index of this panel in the panels array */
  panelIndex?: number
  /** When true, show the panel index number as an overlay badge */
  showIndex?: boolean
}

/**
 * A positioned, draggable, resizable floating panel on the infinite canvas.
 * Handles: drag to reposition, click-to-front z-index, close, resize, focus.
 *
 * Memoized so that only the panel whose data changed re-renders — prevents
 * iframes/terminals from being remounted when a *different* panel moves.
 */
export const CanvasPanel = memo(function CanvasPanel({ panel, zoom, frozen = false, panelIndex, showIndex = false }: CanvasPanelProps) {
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
      const { panels: allPanels, edges } = useCanvasStore.getState()
      const otherPanels = allPanels.filter((p) => p.id !== panel.id)
      const { x: snappedX, y: snappedY, guides } = calculateSnap(
        { x: newX, y: newY, width: panel.width, height: panel.height },
        otherPanels
      )

      updatePanel(panel.id, { x: snappedX, y: snappedY })
      setSnapGuides(guides)

      // Auto-connect proximity detection (browser ↔ task)
      const draggedWithPos = { ...panel, x: snappedX, y: snappedY }
      const prox = detectProximityEdge(draggedWithPos, otherPanels, edges)
      useCanvasStore.getState().setProximityEdge(prox)
    }

    const handleUp = () => {
      // If there's a proximity edge, auto-connect on drop
      const prox = useCanvasStore.getState().proximityEdge
      if (prox) {
        const { edges } = useCanvasStore.getState()
        const alreadyExists = edges.some(
          (e) =>
            (e.fromPanelId === prox.fromId && e.toPanelId === prox.toId) ||
            (e.fromPanelId === prox.toId && e.toPanelId === prox.fromId)
        )
        if (!alreadyExists) {
          // Determine edge type from the panel types
          const allPanels = useCanvasStore.getState().panels
          const fromP = allPanels.find((p) => p.id === prox.fromId)
          const toP = allPanels.find((p) => p.id === prox.toId)
          const isBrowser = fromP?.type === 'browser' || toP?.type === 'browser'
          const isTerminal = fromP?.type === 'terminal' || toP?.type === 'terminal'
          addEdge(prox.fromId, prox.toId, isBrowser ? 'browser' : isTerminal ? 'terminal' : undefined)
        }
        useCanvasStore.getState().setProximityEdge(null)
      }

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
        const isTerminalEdge = panel.type === 'terminal' || fromPanel?.type === 'terminal'
        const edgeType = isBrowserEdge ? 'browser' : isTerminalEdge ? 'terminal' : undefined
        addEdge(connectingFrom, panel.id, edgeType)
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

  // ── Side handle auto-hide after 20s of panel inactivity ──────
  const [sideHandleVisible, setSideHandleVisible] = useState(false)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handlePanelMouseEnter = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    setSideHandleVisible(true)
    hideTimerRef.current = setTimeout(() => setSideHandleVisible(false), 20_000)
  }, [])

  const handlePanelMouseLeave = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    setSideHandleVisible(false)
  }, [])

  // Clean up timer on unmount
  useEffect(() => {
    return () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current) }
  }, [])

  // ── Proximity glow — this panel is a target of auto-connect proximity ──
  const [isProximityTarget, setIsProximityTarget] = useState(false)
  useEffect(() => {
    const unsub = useCanvasStore.subscribe((s, prev) => {
      if (s.proximityEdge !== prev.proximityEdge) {
        const isTarget = s.proximityEdge
          ? (s.proximityEdge.fromId === panel.id || s.proximityEdge.toId === panel.id) &&
            s.draggingPanelId !== panel.id
          : false
        setIsProximityTarget(isTarget)
      }
    })
    return unsub
  }, [panel.id])

  // ── Task status for dynamic color coding ─────────────────
  const taskStatus = useTaskStore(useCallback((s) =>
    panel.type === 'task' ? s.tasks.find(t => t.id === panel.refId)?.status : undefined,
    [panel.type, panel.refId])
  )

  // ── Create connected browser panel (from side handle click) ──
  const handleCreateBrowser = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      e.preventDefault()
      // Place new browser panel to the right of this panel with a gap
      const gap = 40
      const newX = panel.x + panel.width + gap
      const newY = panel.y
      const addPanel = useCanvasStore.getState().addPanel
      const newId = addPanel({
        type: 'browser',
        title: 'Browser',
        x: newX,
        y: newY,
        width: DEFAULT_PANEL_WIDTH,
        height: DEFAULT_PANEL_HEIGHT,
      })
      // Auto-connect with browser edge
      if (newId) {
        addEdge(panel.id, newId, 'browser')
      }
    },
    [panel.id, panel.x, panel.y, panel.width, addEdge]
  )

  // ── Start connecting from side handle (drag) ──
  const handleSideHandleDrag = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      e.preventDefault()
      // Enter connection mode — the user drags to an existing browser panel
      setConnectingFromId(panel.id)
      setIsConnectingLocal(true)
    },
    [setConnectingFromId, panel.id]
  )

  // ── Panel type styling ────────────────────────────────────
  const cfg = useMemo(() => {
    const TYPE_CONFIG: Record<string, { label: string; color: string; border: string }> = {
      task: { label: 'Task', color: 'bg-blue-500/20 text-blue-400', border: 'border-blue-500/40' },
      transcript: { label: 'Transcript', color: 'bg-purple-500/20 text-purple-400', border: 'border-purple-500/40' },
      app: { label: 'App', color: 'bg-green-500/20 text-green-400', border: 'border-green-500/40' },
      webpage: { label: 'Web', color: 'bg-cyan-500/20 text-cyan-400', border: 'border-cyan-500/40' },
      terminal: { label: 'Terminal', color: 'bg-amber-500/20 text-amber-400', border: 'border-amber-500/50' },
      browser: { label: 'Browser', color: 'bg-orange-500/20 text-orange-400', border: 'border-orange-500/40' },
    }

    if (panel.type === 'task' && taskStatus) {
      switch (taskStatus) {
        case TaskStatus.AgentLearning:
          return { label: 'Learning', color: 'bg-blue-500/20 text-blue-400', border: 'border-blue-500/50' }
        case TaskStatus.AgentWorking:
          return { label: 'Working', color: 'bg-amber-500/20 text-amber-400', border: 'border-amber-500/50' }
        case TaskStatus.Completed:
          return { label: 'Completed', color: 'bg-green-500/20 text-green-400', border: 'border-green-500/50' }
        case TaskStatus.Triaging:
          return { label: 'Triaging', color: 'bg-orange-500/20 text-orange-400', border: 'border-orange-500/50' }
        case TaskStatus.ReadyForReview:
          return { label: 'Review', color: 'bg-purple-500/20 text-purple-400', border: 'border-purple-500/50' }
        default:
          return TYPE_CONFIG.task
      }
    }

    return TYPE_CONFIG[panel.type] ?? { label: 'Panel', color: 'bg-muted/30 text-muted-foreground', border: 'border-border/50' }
  }, [panel.type, taskStatus])

  return (
    <div
      ref={panelRef}
      data-canvas-panel="true"
      onMouseDown={handleMouseDown}
      onMouseEnter={handlePanelMouseEnter}
      onMouseLeave={handlePanelMouseLeave}
      className={`absolute rounded-xl border bg-[#1a2030] shadow-2xl flex flex-col select-none transition-shadow duration-150 group/panel ${cfg.border} ${
        isDragging ? 'shadow-indigo-500/10 ring-1 ring-indigo-500/30' : ''
      } ${isConnectingLocal ? 'ring-2 ring-orange-500/50' : ''} ${
        isProximityTarget ? 'ring-2 ring-orange-500/60 shadow-orange-500/20 shadow-2xl' : ''
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
      {/* Inner wrapper — clips content within rounded corners */}
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden rounded-[11px]">
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

        {/* Panel actions — visible on hover */}
        <div className={`flex items-center gap-0.5 transition-opacity duration-150 opacity-0 group-hover:opacity-100`}>
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

      </div>{/* end inner wrapper */}

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

      {/* Side handle — React Flow style, for task panels: click to create browser, drag to connect */}
      {panel.type === 'task' && !isCollapsed && !isDragging && (
        <div
          className={`absolute transition-opacity duration-200 ${sideHandleVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          style={{
            right: -18,
            top: '50%',
            transform: 'translateY(-50%)',
            zIndex: 10,
          }}
        >
          <button
            onMouseDown={(e) => {
              e.stopPropagation()
              const startX = e.clientX
              const startY = e.clientY
              let moved = false

              const onMove = (me: MouseEvent) => {
                if (Math.abs(me.clientX - startX) > 5 || Math.abs(me.clientY - startY) > 5) {
                  moved = true
                  handleSideHandleDrag(e)
                  window.removeEventListener('mousemove', onMove)
                }
              }
              const onUp = () => {
                window.removeEventListener('mousemove', onMove)
                window.removeEventListener('mouseup', onUp)
                if (!moved) {
                  handleCreateBrowser(e)
                }
              }
              window.addEventListener('mousemove', onMove)
              window.addEventListener('mouseup', onUp)
            }}
            className="flex items-center justify-center w-8 h-8 rounded-full bg-orange-500/20 border border-orange-500/40 hover:bg-orange-500/30 hover:border-orange-500/60 hover:scale-110 transition-all duration-150 cursor-pointer shadow-lg shadow-orange-500/10"
            title="Click to add browser · Drag to connect to existing browser"
          >
            <Globe className="h-3.5 w-3.5 text-orange-400" />
          </button>
        </div>
      )}

      {/* Panel index badge — shown when Ctrl/Cmd is held */}
      {showIndex && panelIndex !== undefined && panelIndex < 9 && (
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none z-50"
          style={{ background: 'rgba(0,0,0,0.5)', borderRadius: 'inherit' }}
        >
          <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-500/90 shadow-2xl shadow-indigo-500/40 border border-indigo-400/50">
            <span className="text-3xl font-bold text-white tabular-nums">
              {panelIndex + 1}
            </span>
          </div>
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
    return <TerminalPanelContent terminalId={id} cwd={url} />
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
