import { useCallback, useRef, useState, useEffect } from 'react'
import { useCanvasStore, DEFAULT_PANEL_WIDTH, DEFAULT_PANEL_HEIGHT } from '@/stores/canvas-store'
import type { SnapGuide } from '@/stores/canvas-store'
import { useUIStore } from '@/stores/ui-store'
import { useTaskStore } from '@/stores/task-store'
import { CanvasPanel } from './CanvasPanel'
import { CanvasConnections } from './CanvasConnections'
import { CanvasContextMenu } from './CanvasContextMenu'
import { Move, ZoomIn, ZoomOut, RotateCcw, MousePointer } from 'lucide-react'
import { Button } from '@/components/ui/Button'

// Grid dot spacing in canvas-space pixels
const GRID_SIZE = 40

/**
 * InfiniteCanvas — the main canvas screen.
 *
 * Supports:
 * - Mouse-wheel zoom (with Ctrl/Meta for pinch-to-zoom on trackpads)
 * - Click-drag panning
 * - Trackpad two-finger pan (wheel events without ctrl)
 * - Pinch-to-zoom on trackpad (wheel events with ctrlKey)
 * - Keyboard shortcuts (space+drag for pan, +/- for zoom, Delete to remove selected)
 * - Panel rendering at canvas coordinates via CSS transforms
 * - Right-click context menu to add panels
 * - Panel connections (visual edges)
 * - Snap guides during drag
 */
export function InfiniteCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const {
    viewport,
    panels,
    snapGuides,
    connectingFromId,
    isLoaded,
    panBy,
    zoomAtPoint,
    zoomTo,
    resetViewport,
    addPanel,
    setConnectingFromId,
    loadCanvas,
  } = useCanvasStore()

  // ── Load persisted canvas state on mount ────────────────
  useEffect(() => {
    if (!isLoaded) {
      loadCanvas()
    }
  }, [isLoaded, loadCanvas])

  // Panning state
  const [isPanning, setIsPanning] = useState(false)
  const panStartRef = useRef({ x: 0, y: 0 })
  const [spaceHeld, setSpaceHeld] = useState(false)

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    clientX: number
    clientY: number
    canvasX: number
    canvasY: number
  } | null>(null)

  // Mouse position in canvas space (for connection drawing)
  const [mouseCanvasPos, setMouseCanvasPos] = useState<{ x: number; y: number } | null>(null)

  // ── Consume pending task from "Open in Canvas" button ────
  const canvasPendingTaskId = useUIStore((s) => s.canvasPendingTaskId)
  const clearCanvasPendingTask = useUIStore((s) => s.clearCanvasPendingTask)
  const canvasPendingApp = useUIStore((s) => s.canvasPendingApp)
  const clearCanvasPendingApp = useUIStore((s) => s.clearCanvasPendingApp)
  const allTasks = useTaskStore((s) => s.tasks)

  useEffect(() => {
    if (!canvasPendingTaskId) return
    // Clear immediately to prevent double-fire on re-render
    clearCanvasPendingTask()

    const task = allTasks.find((t) => t.id === canvasPendingTaskId)
    if (!task) return

    // Read panels from store directly to avoid stale closure
    const currentPanels = useCanvasStore.getState().panels
    const alreadyExists = currentPanels.some(
      (p) => p.type === 'task' && p.refId === canvasPendingTaskId
    )
    if (alreadyExists) return

    // Place at center of viewport
    const container = containerRef.current
    const rect = container?.getBoundingClientRect()
    const vp = useCanvasStore.getState().viewport
    const centerX = rect
      ? (rect.width / 2 - vp.x) / vp.zoom - DEFAULT_PANEL_WIDTH / 2
      : 0
    const centerY = rect
      ? (rect.height / 2 - vp.y) / vp.zoom - DEFAULT_PANEL_HEIGHT / 2
      : 0
    const offset = (currentPanels.length % 5) * 30
    addPanel({
      type: 'task',
      title: task.title,
      refId: task.id,
      x: centerX + offset,
      y: centerY + offset,
      width: DEFAULT_PANEL_WIDTH,
      height: DEFAULT_PANEL_HEIGHT,
    })
  }, [canvasPendingTaskId])

  // ── Consume pending app from "Open in Canvas" button ────
  useEffect(() => {
    if (!canvasPendingApp) return
    const { workflowId, name } = canvasPendingApp
    clearCanvasPendingApp()

    const currentPanels = useCanvasStore.getState().panels
    const alreadyExists = currentPanels.some(
      (p) => p.type === 'app' && p.refId === workflowId
    )
    if (alreadyExists) return

    const container = containerRef.current
    const rect = container?.getBoundingClientRect()
    const vp = useCanvasStore.getState().viewport
    const centerX = rect
      ? (rect.width / 2 - vp.x) / vp.zoom - DEFAULT_PANEL_WIDTH / 2
      : 0
    const centerY = rect
      ? (rect.height / 2 - vp.y) / vp.zoom - DEFAULT_PANEL_HEIGHT / 2
      : 0
    const offset = (currentPanels.length % 5) * 30
    addPanel({
      type: 'app',
      title: name,
      refId: workflowId,
      x: centerX + offset,
      y: centerY + offset,
      width: DEFAULT_PANEL_WIDTH,
      height: DEFAULT_PANEL_HEIGHT,
    })
  }, [canvasPendingApp])

  // ── Wheel handler (zoom + trackpad pan) ──────────────────
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      const container = containerRef.current
      if (!container) return

      // Check if the wheel event is inside a scrollable panel element.
      // If so, let the panel scroll naturally instead of panning the canvas.
      // Exception: Ctrl/Meta+wheel is always zoom regardless of target.
      if (!(e.ctrlKey || e.metaKey)) {
        let el = e.target as HTMLElement | null
        while (el && el !== container) {
          // Check for data attribute marking panel content areas
          if (el.dataset?.canvasPanel === 'true') break // reached panel boundary, stop
          const style = window.getComputedStyle(el)
          const overflowY = style.overflowY
          const overflowX = style.overflowX
          const isScrollableY =
            (overflowY === 'auto' || overflowY === 'scroll') &&
            el.scrollHeight > el.clientHeight
          const isScrollableX =
            (overflowX === 'auto' || overflowX === 'scroll') &&
            el.scrollWidth > el.clientWidth

          if (isScrollableY || isScrollableX) {
            // Check if the element can still scroll in the direction of the wheel
            const canScrollDown = isScrollableY && e.deltaY > 0 && el.scrollTop < el.scrollHeight - el.clientHeight - 1
            const canScrollUp = isScrollableY && e.deltaY < 0 && el.scrollTop > 0
            const canScrollRight = isScrollableX && e.deltaX > 0 && el.scrollLeft < el.scrollWidth - el.clientWidth - 1
            const canScrollLeft = isScrollableX && e.deltaX < 0 && el.scrollLeft > 0

            if (canScrollDown || canScrollUp || canScrollRight || canScrollLeft) {
              // Let the nested element handle scroll naturally
              return
            }
          }
          el = el.parentElement
        }
      }

      e.preventDefault()

      if (e.ctrlKey || e.metaKey) {
        const rect = container.getBoundingClientRect()
        zoomAtPoint(e.deltaY, e.clientX, e.clientY, rect)
      } else {
        panBy(-e.deltaX, -e.deltaY)
      }
    },
    [panBy, zoomAtPoint]
  )

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  // ── Mouse-drag panning ───────────────────────────────────
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Close context menu on any click
      if (contextMenu) {
        setContextMenu(null)
        return
      }

      // Cancel connect mode on background click
      if (connectingFromId && e.button === 0) {
        const target = e.target as HTMLElement
        if (target === containerRef.current || target.dataset?.canvasBg === 'true') {
          setConnectingFromId(null)
          return
        }
      }

      const isMiddle = e.button === 1
      const isLeftOnCanvas =
        e.button === 0 &&
        (e.target === containerRef.current ||
          (e.target as HTMLElement).dataset?.canvasBg === 'true')
      const isSpacePan = e.button === 0 && spaceHeld

      if (isMiddle || isLeftOnCanvas || isSpacePan) {
        e.preventDefault()
        setIsPanning(true)
        panStartRef.current = { x: e.clientX, y: e.clientY }
      }
    },
    [spaceHeld, contextMenu, connectingFromId, setConnectingFromId]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Track mouse position for connection drawing
      if (connectingFromId && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect()
        const canvasX = (e.clientX - rect.left - viewport.x) / viewport.zoom
        const canvasY = (e.clientY - rect.top - viewport.y) / viewport.zoom
        setMouseCanvasPos({ x: canvasX, y: canvasY })
      }

      if (!isPanning) return
      const dx = e.clientX - panStartRef.current.x
      const dy = e.clientY - panStartRef.current.y
      panStartRef.current = { x: e.clientX, y: e.clientY }
      panBy(dx, dy)
    },
    [isPanning, panBy, connectingFromId, viewport.x, viewport.y, viewport.zoom]
  )

  const handleMouseUp = useCallback(() => {
    setIsPanning(false)
  }, [])

  // ── Context menu ─────────────────────────────────────────
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      const canvasX = (e.clientX - rect.left - viewport.x) / viewport.zoom
      const canvasY = (e.clientY - rect.top - viewport.y) / viewport.zoom
      setContextMenu({
        clientX: e.clientX,
        clientY: e.clientY,
        canvasX,
        canvasY,
      })
    },
    [viewport]
  )

  // ── Keyboard shortcuts ───────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        setSpaceHeld(true)
      }
      if (e.code === 'Equal' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        zoomTo(viewport.zoom * 1.2)
      }
      if (e.code === 'Minus' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        zoomTo(viewport.zoom / 1.2)
      }
      if (e.code === 'Digit0' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        resetViewport()
      }
      // Escape: cancel connect mode
      if (e.code === 'Escape') {
        setConnectingFromId(null)
        setContextMenu(null)
      }
    }
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setSpaceHeld(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [viewport.zoom, zoomTo, resetViewport, setConnectingFromId])

  const zoomPercent = Math.round(viewport.zoom * 100)

  const cursorStyle = connectingFromId
    ? 'crosshair'
    : isPanning || spaceHeld
      ? 'grabbing'
      : 'default'

  return (
    <div className="relative w-full h-full overflow-hidden bg-[#0d1117]">
      {/* Canvas container */}
      <div
        ref={containerRef}
        className="absolute inset-0"
        style={{ cursor: cursorStyle }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onContextMenu={handleContextMenu}
      >
        {/* Transformed layer */}
        <div
          style={{
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
            transformOrigin: '0 0',
            position: 'absolute',
            top: 0,
            left: 0,
            width: 0,
            height: 0,
          }}
        >
          {/* Background grid dots */}
          <CanvasGrid
            zoom={viewport.zoom}
            viewportX={viewport.x}
            viewportY={viewport.y}
            containerRef={containerRef}
          />

          {/* Snap guides */}
          <SnapGuides guides={snapGuides} containerRef={containerRef} viewport={viewport} />

          {/* Connection lines */}
          <CanvasConnections mouseCanvasPos={connectingFromId ? mouseCanvasPos : null} />

          {/* Render panels */}
          {panels.map((panel) => (
            <CanvasPanel key={panel.id} panel={panel} zoom={viewport.zoom} />
          ))}
        </div>

        {/* Click target for background */}
        <div data-canvas-bg="true" className="absolute inset-0" style={{ zIndex: -1 }} />
      </div>

      {/* ── HUD: zoom controls ── */}
      <div className="absolute bottom-4 left-4 flex items-center gap-1 bg-[#161b22]/90 backdrop-blur-sm border border-border/30 rounded-lg p-1 z-10">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => zoomTo(viewport.zoom / 1.2)}
          title="Zoom out"
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <span className="text-xs text-muted-foreground w-10 text-center tabular-nums">
          {zoomPercent}%
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => zoomTo(viewport.zoom * 1.2)}
          title="Zoom in"
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
        <div className="w-px h-4 bg-border/30 mx-0.5" />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={resetViewport}
          title="Reset view (Ctrl+0)"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* ── HUD: Viewport info ── */}
      <div className="absolute top-3 right-3 flex items-center gap-2 text-[10px] text-muted-foreground/40 z-10 select-none">
        <Move className="h-3 w-3" />
        <span className="tabular-nums">
          {Math.round(-viewport.x / viewport.zoom)},{' '}
          {Math.round(-viewport.y / viewport.zoom)}
        </span>
      </div>

      {/* ── Connect mode indicator ── */}
      {connectingFromId && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="flex items-center gap-2 bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 rounded-lg px-3 py-1.5 text-xs backdrop-blur-sm">
            <MousePointer className="h-3 w-3" />
            <span>Click a panel to connect, or press Esc to cancel</span>
          </div>
        </div>
      )}

      {/* ── Empty state ── */}
      {panels.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-0">
          <div className="text-center">
            <div className="text-muted-foreground/30 text-sm font-medium mb-1">
              Infinite Canvas
            </div>
            <div className="text-muted-foreground/20 text-xs">
              Scroll to pan &middot; Pinch or Ctrl+scroll to zoom &middot;
              Right-click to add tasks &amp; apps
            </div>
          </div>
        </div>
      )}

      {/* ── Context menu ── */}
      {contextMenu && (
        <CanvasContextMenu
          position={contextMenu}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}

// ── Grid dots background ───────────────────────────────────

function CanvasGrid({
  zoom,
  viewportX,
  viewportY,
  containerRef,
}: {
  zoom: number
  viewportX: number
  viewportY: number
  containerRef: React.RefObject<HTMLDivElement | null>
}) {
  const container = containerRef.current
  if (!container) return null

  const rect = container.getBoundingClientRect()
  const visibleLeft = -viewportX / zoom
  const visibleTop = -viewportY / zoom
  const visibleWidth = rect.width / zoom
  const visibleHeight = rect.height / zoom

  const gridLeft = Math.floor(visibleLeft / GRID_SIZE) * GRID_SIZE - GRID_SIZE
  const gridTop = Math.floor(visibleTop / GRID_SIZE) * GRID_SIZE - GRID_SIZE
  const gridWidth = visibleWidth + GRID_SIZE * 3
  const gridHeight = visibleHeight + GRID_SIZE * 3

  const dotSize = Math.max(1, Math.min(2, 1.5 / zoom))

  return (
    <div
      style={{
        position: 'absolute',
        left: gridLeft,
        top: gridTop,
        width: gridWidth,
        height: gridHeight,
        backgroundImage: `radial-gradient(circle, rgba(255,255,255,0.06) ${dotSize}px, transparent ${dotSize}px)`,
        backgroundSize: `${GRID_SIZE}px ${GRID_SIZE}px`,
        backgroundPosition: `${GRID_SIZE / 2}px ${GRID_SIZE / 2}px`,
        pointerEvents: 'none',
      }}
    />
  )
}

// ── Snap guide lines ───────────────────────────────────────

function SnapGuides({
  guides,
  containerRef,
  viewport,
}: {
  guides: SnapGuide[]
  containerRef: React.RefObject<HTMLDivElement | null>
  viewport: { x: number; y: number; zoom: number }
}) {
  if (guides.length === 0) return null

  const container = containerRef.current
  if (!container) return null

  const rect = container.getBoundingClientRect()
  const visibleLeft = -viewport.x / viewport.zoom
  const visibleTop = -viewport.y / viewport.zoom
  const visibleWidth = rect.width / viewport.zoom
  const visibleHeight = rect.height / viewport.zoom

  return (
    <>
      {guides.map((guide, i) => (
        <div
          key={`${guide.axis}-${guide.position}-${i}`}
          className="absolute pointer-events-none"
          style={
            guide.axis === 'x'
              ? {
                  left: guide.position,
                  top: visibleTop - 1000,
                  width: 1,
                  height: visibleHeight + 2000,
                  background: 'rgba(99,102,241,0.25)',
                }
              : {
                  left: visibleLeft - 1000,
                  top: guide.position,
                  width: visibleWidth + 2000,
                  height: 1,
                  background: 'rgba(99,102,241,0.25)',
                }
          }
        />
      ))}
    </>
  )
}
