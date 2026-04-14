import { useCallback, useRef, useState, useEffect } from 'react'
import { useCanvasStore, DEFAULT_PANEL_WIDTH, DEFAULT_PANEL_HEIGHT } from '@/stores/canvas-store'
import { CanvasPanel } from './CanvasPanel'
import { Move, ZoomIn, ZoomOut, RotateCcw, Plus } from 'lucide-react'
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
 * - Keyboard shortcuts (space+drag for pan, +/- for zoom)
 * - Panel rendering at canvas coordinates via CSS transforms
 */
export function InfiniteCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const { viewport, panels, panBy, zoomAtPoint, zoomTo, resetViewport, addPanel } = useCanvasStore()

  // Panning state
  const [isPanning, setIsPanning] = useState(false)
  const panStartRef = useRef({ x: 0, y: 0 })
  const [spaceHeld, setSpaceHeld] = useState(false)

  // ── Wheel handler (zoom + trackpad pan) ──────────────────
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault()
      const container = containerRef.current
      if (!container) return

      if (e.ctrlKey || e.metaKey) {
        // Pinch-to-zoom (trackpad) or Ctrl+wheel
        const rect = container.getBoundingClientRect()
        zoomAtPoint(e.deltaY, e.clientX, e.clientY, rect)
      } else {
        // Two-finger trackpad pan / regular scroll
        panBy(-e.deltaX, -e.deltaY)
      }
    },
    [panBy, zoomAtPoint]
  )

  // Attach wheel listener with { passive: false } to allow preventDefault
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  // ── Mouse-drag panning ───────────────────────────────────
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only pan on middle-click, or left-click on the canvas background (not on panels)
      const isMiddle = e.button === 1
      const isLeftOnCanvas = e.button === 0 && (e.target === containerRef.current || (e.target as HTMLElement).dataset?.canvasBg === 'true')
      const isSpacePan = e.button === 0 && spaceHeld

      if (isMiddle || isLeftOnCanvas || isSpacePan) {
        e.preventDefault()
        setIsPanning(true)
        panStartRef.current = { x: e.clientX, y: e.clientY }
      }
    },
    [spaceHeld]
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

  // ── Add demo panel ───────────────────────────────────────
  const handleAddPanel = useCallback(() => {
    // Place new panel at center of current viewport
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const centerCanvasX = (rect.width / 2 - viewport.x) / viewport.zoom - DEFAULT_PANEL_WIDTH / 2
    const centerCanvasY = (rect.height / 2 - viewport.y) / viewport.zoom - DEFAULT_PANEL_HEIGHT / 2
    // Slight random offset to avoid stacking exactly
    const offset = (panels.length % 5) * 30
    addPanel({
      type: 'placeholder',
      title: `Panel ${panels.length + 1}`,
      x: centerCanvasX + offset,
      y: centerCanvasY + offset,
      width: DEFAULT_PANEL_WIDTH,
      height: DEFAULT_PANEL_HEIGHT,
    })
  }, [addPanel, panels.length, viewport])

  const zoomPercent = Math.round(viewport.zoom * 100)

  return (
    <div className="relative w-full h-full overflow-hidden bg-[#0d1117]">
      {/* Canvas container — captures all mouse events for pan */}
      <div
        ref={containerRef}
        className="absolute inset-0"
        style={{ cursor: isPanning || spaceHeld ? 'grabbing' : 'default' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {/* Transformed layer — this moves/scales with the viewport */}
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
          <CanvasGrid zoom={viewport.zoom} viewportX={viewport.x} viewportY={viewport.y} containerRef={containerRef} />

          {/* Render panels */}
          {panels.map((panel) => (
            <CanvasPanel key={panel.id} panel={panel} />
          ))}
        </div>

        {/* Click target for background (enables left-click pan on empty area) */}
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

      {/* ── HUD: Add panel button ── */}
      <div className="absolute bottom-4 right-4 z-10">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-3 bg-[#161b22]/90 backdrop-blur-sm border border-border/30"
          onClick={handleAddPanel}
          title="Add a panel"
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          <span className="text-xs">Add Panel</span>
        </Button>
      </div>

      {/* ── HUD: Viewport info (top-right) ── */}
      <div className="absolute top-3 right-3 flex items-center gap-2 text-[10px] text-muted-foreground/40 z-10 select-none">
        <Move className="h-3 w-3" />
        <span className="tabular-nums">
          {Math.round(-viewport.x / viewport.zoom)}, {Math.round(-viewport.y / viewport.zoom)}
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
              Scroll to pan &middot; Pinch or Ctrl+scroll to zoom &middot; Click "Add Panel" to start
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Grid dots background ───────────────────────────────────

function CanvasGrid({
  zoom,
  viewportX,
  viewportY,
  containerRef
}: {
  zoom: number
  viewportX: number
  viewportY: number
  containerRef: React.RefObject<HTMLDivElement | null>
}) {
  // Use a CSS background pattern on a large backing div to draw dots
  // The div is sized to cover the visible area (in canvas space)
  const container = containerRef.current
  if (!container) return null

  const rect = container.getBoundingClientRect()
  // Calculate the visible area in canvas space
  const visibleLeft = -viewportX / zoom
  const visibleTop = -viewportY / zoom
  const visibleWidth = rect.width / zoom
  const visibleHeight = rect.height / zoom

  // Snap to grid for clean alignment
  const gridLeft = Math.floor(visibleLeft / GRID_SIZE) * GRID_SIZE - GRID_SIZE
  const gridTop = Math.floor(visibleTop / GRID_SIZE) * GRID_SIZE - GRID_SIZE
  const gridWidth = visibleWidth + GRID_SIZE * 3
  const gridHeight = visibleHeight + GRID_SIZE * 3

  // Adapt dot size to zoom level so dots don't become huge
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
