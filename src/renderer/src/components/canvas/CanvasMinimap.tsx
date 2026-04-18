import { useCallback, useRef, useState, useMemo } from 'react'
import { useCanvasStore, type CanvasPanelData, MIN_ZOOM, MAX_ZOOM } from '@/stores/canvas-store'
import { Minus, Plus, Maximize2, ChevronDown, ChevronUp } from 'lucide-react'

// ── Constants ─────────────────────────────────────────────
const MINIMAP_W = 180
const MINIMAP_H = 120
const MINIMAP_PAD = 12 // padding inside the minimap

// Panel type → color mapping
const PANEL_COLORS: Record<string, string> = {
  task: 'rgba(99,102,241,0.7)',     // indigo
  browser: 'rgba(249,115,22,0.7)',  // orange
  terminal: 'rgba(34,197,94,0.7)',  // green
  app: 'rgba(168,85,247,0.7)',      // purple
  transcript: 'rgba(59,130,246,0.6)', // blue
  webpage: 'rgba(236,72,153,0.6)',  // pink
  placeholder: 'rgba(107,114,128,0.4)', // gray
}

/**
 * CanvasMinimap — a small overview map in the bottom-right corner.
 *
 * Shows all panels as colored rectangles, the current viewport as a
 * semi-transparent rectangle, and supports:
 * - Click to navigate to a location
 * - Drag the viewport rectangle to pan
 * - Zoom controls (+/-)
 * - Fit-to-content button
 * - Collapsible
 */
export function CanvasMinimap({
  containerWidth,
  containerHeight,
}: {
  containerWidth: number
  containerHeight: number
}) {
  const panels = useCanvasStore((s) => s.panels)
  const viewport = useCanvasStore((s) => s.viewport)
  const edges = useCanvasStore((s) => s.edges)
  const setViewport = useCanvasStore((s) => s.setViewport)
  const zoomTo = useCanvasStore((s) => s.zoomTo)
  const fitToContent = useCanvasStore((s) => s.fitToContent)

  const [collapsed, setCollapsed] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const svgRef = useRef<SVGSVGElement>(null)

  // ── Compute bounding box of all panels ──────────────────
  const bounds = useMemo(() => {
    if (panels.length === 0) {
      return { minX: 0, minY: 0, maxX: 1000, maxY: 800 }
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of panels) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x + p.width)
      maxY = Math.max(maxY, p.y + p.height)
    }
    // Also include the viewport visible area so it never clips out
    const vpLeft = -viewport.x / viewport.zoom
    const vpTop = -viewport.y / viewport.zoom
    const vpRight = vpLeft + containerWidth / viewport.zoom
    const vpBottom = vpTop + containerHeight / viewport.zoom
    minX = Math.min(minX, vpLeft)
    minY = Math.min(minY, vpTop)
    maxX = Math.max(maxX, vpRight)
    maxY = Math.max(maxY, vpBottom)

    // Add padding
    const pad = 100
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad }
  }, [panels, viewport, containerWidth, containerHeight])

  // ── Scale factor: canvas space → minimap space ──────────
  const canvasW = bounds.maxX - bounds.minX
  const canvasH = bounds.maxY - bounds.minY
  const innerW = MINIMAP_W - MINIMAP_PAD * 2
  const innerH = MINIMAP_H - MINIMAP_PAD * 2
  const scale = Math.min(innerW / canvasW, innerH / canvasH)

  // Transform canvas coord → minimap coord
  const toMiniX = (cx: number) => MINIMAP_PAD + (cx - bounds.minX) * scale
  const toMiniY = (cy: number) => MINIMAP_PAD + (cy - bounds.minY) * scale

  // ── Viewport rectangle in minimap ──────────────────────
  const vpLeft = -viewport.x / viewport.zoom
  const vpTop = -viewport.y / viewport.zoom
  const vpW = containerWidth / viewport.zoom
  const vpH = containerHeight / viewport.zoom
  const vpRect = {
    x: toMiniX(vpLeft),
    y: toMiniY(vpTop),
    w: vpW * scale,
    h: vpH * scale,
  }

  // ── Click/drag on minimap → pan canvas ──────────────────
  const panToMinimapPoint = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      const mx = clientX - rect.left
      const my = clientY - rect.top

      // Convert minimap coord → canvas coord
      const canvasX = (mx - MINIMAP_PAD) / scale + bounds.minX
      const canvasY = (my - MINIMAP_PAD) / scale + bounds.minY

      // Center the viewport on this point
      const newVpX = -(canvasX * viewport.zoom - containerWidth / 2)
      const newVpY = -(canvasY * viewport.zoom - containerHeight / 2)
      setViewport({ x: newVpX, y: newVpY })
    },
    [scale, bounds, viewport.zoom, containerWidth, containerHeight, setViewport]
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(true)
      panToMinimapPoint(e.clientX, e.clientY)
    },
    [panToMinimapPoint]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging) return
      panToMinimapPoint(e.clientX, e.clientY)
    },
    [isDragging, panToMinimapPoint]
  )

  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
  }, [])

  // ── Edge lines in minimap ─────────────────────────────
  const panelMap = useMemo(() => {
    const map = new Map<string, CanvasPanelData>()
    for (const p of panels) map.set(p.id, p)
    return map
  }, [panels])

  const zoomPercent = Math.round(viewport.zoom * 100)

  if (panels.length === 0) return null

  return (
    <div
      className="absolute bottom-4 right-4 z-10 select-none"
      style={{ pointerEvents: 'auto' }}
    >
      {/* Header bar — always visible */}
      <div
        className="flex items-center justify-between px-2 py-1 bg-[#1a2030]/95 backdrop-blur-sm border border-border/40 rounded-t-lg cursor-pointer"
        style={{ width: MINIMAP_W, borderBottom: collapsed ? undefined : 'none', borderRadius: collapsed ? '8px' : undefined }}
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">
          Map
        </span>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground/40 tabular-nums">
            {zoomPercent}%
          </span>
          {collapsed ? (
            <ChevronUp className="h-3 w-3 text-muted-foreground/40" />
          ) : (
            <ChevronDown className="h-3 w-3 text-muted-foreground/40" />
          )}
        </div>
      </div>

      {/* Minimap body */}
      {!collapsed && (
        <div
          className="bg-[#0d1117]/95 backdrop-blur-sm border border-border/40 border-t-0 rounded-b-lg overflow-hidden"
          style={{ width: MINIMAP_W }}
        >
          {/* SVG minimap */}
          <svg
            ref={svgRef}
            width={MINIMAP_W}
            height={MINIMAP_H}
            className="cursor-crosshair"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            {/* Edge lines */}
            {edges.map((edge) => {
              const from = panelMap.get(edge.fromPanelId)
              const to = panelMap.get(edge.toPanelId)
              if (!from || !to) return null
              const isBrowser = edge.edgeType === 'browser'
              return (
                <line
                  key={edge.id}
                  x1={toMiniX(from.x + from.width / 2)}
                  y1={toMiniY(from.y + from.height / 2)}
                  x2={toMiniX(to.x + to.width / 2)}
                  y2={toMiniY(to.y + to.height / 2)}
                  stroke={isBrowser ? 'rgba(249,115,22,0.4)' : 'rgba(99,102,241,0.3)'}
                  strokeWidth="1"
                />
              )
            })}

            {/* Panel rectangles */}
            {panels.map((p) => {
              const color = PANEL_COLORS[p.type] || 'rgba(148,163,184,0.5)'
              const px = toMiniX(p.x)
              const py = toMiniY(p.y)
              const pw = Math.max(3, p.width * scale)
              const ph = Math.max(2, p.height * scale)
              return (
                <rect
                  key={p.id}
                  x={px}
                  y={py}
                  width={pw}
                  height={ph}
                  rx="1"
                  fill={color}
                  stroke="rgba(255,255,255,0.1)"
                  strokeWidth="0.5"
                />
              )
            })}

            {/* Viewport rectangle */}
            <rect
              x={vpRect.x}
              y={vpRect.y}
              width={Math.max(4, vpRect.w)}
              height={Math.max(3, vpRect.h)}
              rx="1"
              fill="rgba(255,255,255,0.06)"
              stroke="rgba(255,255,255,0.3)"
              strokeWidth="1"
              className="pointer-events-none"
            />
          </svg>

          {/* Zoom controls bar */}
          <div className="flex items-center justify-between px-1.5 py-1 border-t border-border/20">
            <button
              className="h-5 w-5 rounded flex items-center justify-center text-muted-foreground/40 hover:text-muted-foreground hover:bg-white/5 transition-colors"
              onClick={(e) => { e.stopPropagation(); zoomTo(viewport.zoom / 1.2) }}
              title="Zoom out (Ctrl+-)"
            >
              <Minus className="h-3 w-3" />
            </button>

            {/* Zoom slider */}
            <input
              type="range"
              min={MIN_ZOOM * 100}
              max={MAX_ZOOM * 100}
              value={viewport.zoom * 100}
              onChange={(e) => {
                e.stopPropagation()
                zoomTo(Number(e.target.value) / 100)
              }}
              className="flex-1 mx-1.5 h-1 accent-indigo-500 cursor-pointer"
              style={{ opacity: 0.5 }}
              title={`Zoom: ${zoomPercent}%`}
            />

            <button
              className="h-5 w-5 rounded flex items-center justify-center text-muted-foreground/40 hover:text-muted-foreground hover:bg-white/5 transition-colors"
              onClick={(e) => { e.stopPropagation(); zoomTo(viewport.zoom * 1.2) }}
              title="Zoom in (Ctrl+=)"
            >
              <Plus className="h-3 w-3" />
            </button>

            <div className="w-px h-3 bg-border/20 mx-0.5" />

            <button
              className="h-5 w-5 rounded flex items-center justify-center text-muted-foreground/40 hover:text-muted-foreground hover:bg-white/5 transition-colors"
              onClick={(e) => { e.stopPropagation(); fitToContent(containerWidth, containerHeight) }}
              title="Fit all panels"
            >
              <Maximize2 className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
