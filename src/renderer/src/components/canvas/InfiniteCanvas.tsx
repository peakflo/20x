import { useCallback, useRef, useState, useEffect } from 'react'
import { useCanvasStore, DEFAULT_PANEL_WIDTH, DEFAULT_PANEL_HEIGHT } from '@/stores/canvas-store'
import type { SnapGuide } from '@/stores/canvas-store'
import { useUIStore } from '@/stores/ui-store'
import { useTaskStore } from '@/stores/task-store'
import { CanvasPanel } from './CanvasPanel'
import { CanvasConnections } from './CanvasConnections'
import { CanvasContextMenu } from './CanvasContextMenu'
import { Move, ZoomIn, ZoomOut, RotateCcw, Plus, Globe, TerminalSquare, X } from 'lucide-react'
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
  const viewport = useCanvasStore((s) => s.viewport)
  const panels = useCanvasStore((s) => s.panels)
  const snapGuides = useCanvasStore((s) => s.snapGuides)
  const isLoaded = useCanvasStore((s) => s.isLoaded)
  const panBy = useCanvasStore((s) => s.panBy)
  const zoomAtPoint = useCanvasStore((s) => s.zoomAtPoint)
  const zoomTo = useCanvasStore((s) => s.zoomTo)
  const resetViewport = useCanvasStore((s) => s.resetViewport)
  const fitToContent = useCanvasStore((s) => s.fitToContent)
  const addPanel = useCanvasStore((s) => s.addPanel)
  const loadCanvas = useCanvasStore((s) => s.loadCanvas)

  // ── Load persisted canvas state on mount ────────────────
  useEffect(() => {
    if (!isLoaded) {
      loadCanvas().then(() => {
        // After loading, fit the viewport to show all panels
        const container = containerRef.current
        if (container) {
          const rect = container.getBoundingClientRect()
          const { panels: loadedPanels } = useCanvasStore.getState()
          if (loadedPanels.length > 0) {
            fitToContent(rect.width, rect.height)
          }
        }
      })
    }
  }, [isLoaded, loadCanvas, fitToContent])

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

  // Add panel dropdown state
  const [showAddMenu, setShowAddMenu] = useState(false)
  const addMenuRef = useRef<HTMLDivElement>(null)

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
    [spaceHeld, contextMenu]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isPanning) return
      const dx = e.clientX - panStartRef.current.x
      const dy = e.clientY - panStartRef.current.y
      panStartRef.current = { x: e.clientX, y: e.clientY }
      panBy(dx, dy)
    },
    [isPanning, panBy]
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

  // ── Add panel helpers ────────────────────────────────────
  const addPanelAtCenter = useCallback(
    (type: 'webpage' | 'terminal', title: string) => {
      const container = containerRef.current
      const rect = container?.getBoundingClientRect()
      const vp = useCanvasStore.getState().viewport
      const currentPanels = useCanvasStore.getState().panels
      const centerX = rect
        ? (rect.width / 2 - vp.x) / vp.zoom - DEFAULT_PANEL_WIDTH / 2
        : 0
      const centerY = rect
        ? (rect.height / 2 - vp.y) / vp.zoom - DEFAULT_PANEL_HEIGHT / 2
        : 0
      const offset = (currentPanels.length % 5) * 30
      addPanel({
        type,
        title,
        x: centerX + offset,
        y: centerY + offset,
        width: DEFAULT_PANEL_WIDTH,
        height: DEFAULT_PANEL_HEIGHT,
      })
      setShowAddMenu(false)
    },
    [addPanel]
  )

  // Close add menu on outside click
  useEffect(() => {
    if (!showAddMenu) return
    const handleClick = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setShowAddMenu(false)
      }
    }
    const timer = setTimeout(() => document.addEventListener('mousedown', handleClick), 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClick)
    }
  }, [showAddMenu])

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
      // Escape: close context menu
      if (e.code === 'Escape') {
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
  }, [viewport.zoom, zoomTo, resetViewport])

  const zoomPercent = Math.round(viewport.zoom * 100)

  const cursorStyle = isPanning || spaceHeld
      ? 'grabbing'
      : 'default'

  return (
    <div data-canvas-root="true" className="overflow-hidden bg-[#131820]" style={{ position: 'relative', width: '100%', height: '100%' }}>
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
          <CanvasConnections mouseCanvasPos={null} />

          {/* Render panels */}
          {panels.map((panel) => (
            <CanvasPanel key={panel.id} panel={panel} zoom={viewport.zoom} />
          ))}
        </div>

        {/* Click target for background */}
        <div data-canvas-bg="true" className="absolute inset-0" style={{ zIndex: -1 }} />
      </div>

      {/* ── HUD: zoom controls ── */}
      <div className="absolute bottom-4 left-4 flex items-center gap-1 bg-[#1a2030]/90 backdrop-blur-sm border border-border/40 rounded-lg p-1 z-10">
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

      {/* ── HUD: Add Panel button ── */}
      <div ref={addMenuRef} className="absolute bottom-4 right-4 z-10">
        {showAddMenu && (
          <div className="absolute bottom-full right-0 mb-2 w-56 bg-[#1a2030]/95 backdrop-blur-sm border border-border/40 rounded-xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-150">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/20">
              <span className="text-[11px] font-medium text-muted-foreground/70">Add Panel</span>
              <button
                onClick={() => setShowAddMenu(false)}
                className="text-muted-foreground/40 hover:text-muted-foreground/80 transition-colors"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <div className="py-1">
              <button
                onClick={() => addPanelAtCenter('webpage', 'Web Page')}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/5 transition-colors group"
              >
                <Globe className="h-4 w-4 text-cyan-400 flex-shrink-0" />
                <div>
                  <div className="text-[12px] text-foreground/80 group-hover:text-foreground transition-colors">
                    Web Page
                  </div>
                  <div className="text-[10px] text-muted-foreground/40">
                    Embed any website
                  </div>
                </div>
              </button>
              <button
                onClick={() => addPanelAtCenter('terminal', 'Terminal')}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/5 transition-colors group"
              >
                <TerminalSquare className="h-4 w-4 text-amber-400 flex-shrink-0" />
                <div>
                  <div className="text-[12px] text-foreground/80 group-hover:text-foreground transition-colors">
                    Terminal
                  </div>
                  <div className="text-[10px] text-muted-foreground/40">
                    Interactive shell session
                  </div>
                </div>
              </button>
            </div>
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-3 bg-[#1a2030]/90 backdrop-blur-sm border border-border/40 hover:border-border/60 text-xs gap-1.5"
          onClick={() => setShowAddMenu(!showAddMenu)}
          title="Add panel"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>Add Panel</span>
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
  // Guard against zero-size container (during window move/minimize transitions)
  if (!rect.width || !rect.height || !zoom) return null

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
        backgroundImage: `radial-gradient(circle, rgba(255,255,255,0.08) ${dotSize}px, transparent ${dotSize}px)`,
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
  if (!rect.width || !rect.height || !viewport.zoom) return null

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
