import { memo, useCallback, useRef, useState, useMemo, useEffect } from 'react'
import { useCanvasStore, type CanvasPanelData, type CanvasEdge, type Viewport, MIN_ZOOM, MAX_ZOOM } from '@/stores/canvas-store'
import { getLiveViewport, subscribeLiveViewport } from '@/stores/canvas-live-viewport'
import { useTaskStore } from '@/stores/task-store'
import { useDrawingStore } from '@/stores/drawing-store'
import { lineEndpoints, unionBox } from './drawing/figure-geometry'
import type { DrawingObject } from './drawing/types'
import { Minus, Plus, Maximize2, ChevronDown, ChevronUp } from 'lucide-react'
import { getCanvasTaskStatusStyle } from './canvas-status-style'

// ── Constants ─────────────────────────────────────────────
const MINIMAP_W = 180
const MINIMAP_H = 120
const MINIMAP_PAD = 12 // padding inside the minimap

// Panel type → color mapping
const PANEL_COLORS: Record<string, string> = {
  task: 'rgba(59,130,246,0.7)',     // fallback blue when a task status is unavailable
  browser: 'rgba(249,115,22,0.7)',  // orange
  terminal: 'rgba(139,92,246,0.7)',  // violet
  app: 'rgba(20,184,166,0.7)',      // teal
  transcript: 'rgba(6,182,212,0.62)', // cyan
  webpage: 'rgba(14,165,233,0.62)',  // sky
  placeholder: 'rgba(107,114,128,0.4)', // gray
}

interface MinimapBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function getClampedViewportRect(
  viewport: Viewport,
  bounds: MinimapBounds,
  containerWidth: number,
  containerHeight: number
) {
  const canvasW = bounds.maxX - bounds.minX
  const canvasH = bounds.maxY - bounds.minY
  const viewportW = containerWidth / viewport.zoom
  const viewportH = containerHeight / viewport.zoom
  const clampedW = Math.min(viewportW, canvasW)
  const clampedH = Math.min(viewportH, canvasH)

  return {
    left: clamp(-viewport.x / viewport.zoom, bounds.minX, bounds.maxX - clampedW),
    top: clamp(-viewport.y / viewport.zoom, bounds.minY, bounds.maxY - clampedH),
    width: clampedW,
    height: clampedH,
  }
}

const MinimapContent = memo(function MinimapContent({
  panels,
  edges,
  figures,
  bounds,
  scale,
  taskStatusMap,
}: {
  panels: CanvasPanelData[]
  edges: CanvasEdge[]
  figures: DrawingObject[]
  bounds: MinimapBounds
  scale: number
  taskStatusMap: Map<string, ReturnType<typeof useTaskStore.getState>['tasks'][number]['status']>
}) {
  const panelMap = useMemo(() => {
    const map = new Map<string, CanvasPanelData>()
    for (const p of panels) map.set(p.id, p)
    return map
  }, [panels])

  const toMiniX = useCallback((cx: number) => MINIMAP_PAD + (cx - bounds.minX) * scale, [bounds.minX, scale])
  const toMiniY = useCallback((cy: number) => MINIMAP_PAD + (cy - bounds.minY) * scale, [bounds.minY, scale])

  return (
    <>
      {/* Edge lines */}
      {edges.map((edge) => {
        const from = panelMap.get(edge.fromPanelId)
        const to = panelMap.get(edge.toPanelId)
        if (!from || !to) return null
        const edgeColor = edge.edgeType === 'browser' ? 'rgba(249,115,22,0.4)'
          : edge.edgeType === 'terminal' ? 'rgba(34,197,94,0.4)'
          : 'rgba(30,150,235,0.3)'
        return (
          <line
            key={edge.id}
            x1={toMiniX(from.x + from.width / 2)}
            y1={toMiniY(from.y + from.height / 2)}
            x2={toMiniX(to.x + to.width / 2)}
            y2={toMiniY(to.y + to.height / 2)}
            stroke={edgeColor}
            strokeWidth="1"
          />
        )
      })}

      {/* Drawing figures — below panels (figures render below panels on the
          canvas too), keeping their real stroke/fill colors. */}
      {figures.map((f) => {
        const px = toMiniX(f.x)
        const py = toMiniY(f.y)
        const pw = Math.max(2, f.width * scale)
        const ph = Math.max(2, f.height * scale)
        if (f.type === 'line' || f.type === 'arrow') {
          const { from, to } = lineEndpoints(
            { x: f.x, y: f.y, width: f.width, height: f.height },
            f.direction
          )
          return (
            <line
              key={f.id}
              x1={toMiniX(from.x)}
              y1={toMiniY(from.y)}
              x2={toMiniX(to.x)}
              y2={toMiniY(to.y)}
              stroke={f.stroke}
              strokeWidth="1"
              opacity={0.8}
            />
          )
        }
        if (f.type === 'ellipse') {
          return (
            <ellipse
              key={f.id}
              cx={px + pw / 2}
              cy={py + ph / 2}
              rx={pw / 2}
              ry={ph / 2}
              fill={f.fill ?? 'none'}
              stroke={f.stroke}
              strokeWidth="1"
              opacity={0.8}
            />
          )
        }
        if (f.type === 'text') {
          // A faint block in the text color — readable at minimap scale.
          return (
            <rect key={f.id} x={px} y={py} width={pw} height={ph} rx="1" fill={f.stroke} opacity={0.3} />
          )
        }
        if (f.type === 'image') {
          return (
            <rect
              key={f.id}
              x={px}
              y={py}
              width={pw}
              height={ph}
              rx="1"
              fill="rgba(148,163,184,0.45)"
              stroke="rgba(255,255,255,0.15)"
              strokeWidth="0.5"
            />
          )
        }
        // rectangle
        return (
          <rect
            key={f.id}
            x={px}
            y={py}
            width={pw}
            height={ph}
            rx="1"
            fill={f.fill ?? 'none'}
            stroke={f.stroke}
            strokeWidth="1"
            opacity={0.8}
          />
        )
      })}

      {/* Panel rectangles */}
      {panels.map((p) => {
        const taskStatusStyle = p.type === 'task' ? getCanvasTaskStatusStyle(taskStatusMap.get(p.refId ?? '')) : null
        const color = taskStatusStyle?.miniFill ?? PANEL_COLORS[p.type] ?? 'rgba(148,163,184,0.5)'
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
    </>
  )
})

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
function CanvasMinimapComponent({
  containerWidth,
  containerHeight,
}: {
  containerWidth: number
  containerHeight: number
}) {
  const panels = useCanvasStore((s) => s.panels)
  const viewport = useCanvasStore((s) => s.viewport)
  const edges = useCanvasStore((s) => s.edges)
  const figures = useDrawingStore((s) => s.objects)
  const tasks = useTaskStore((s) => s.tasks)
  const setViewport = useCanvasStore((s) => s.setViewport)
  const zoomTo = useCanvasStore((s) => s.zoomTo)
  const fitToContent = useCanvasStore((s) => s.fitToContent)

  const [collapsed, setCollapsed] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const svgRef = useRef<SVGSVGElement>(null)

  // ── Compute bounding box of all panels + drawing figures ──
  const bounds = useMemo(() => {
    if (panels.length === 0 && figures.length === 0) {
      return { minX: 0, minY: 0, maxX: 1000, maxY: 800 }
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of panels) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x + p.width)
      maxY = Math.max(maxY, p.y + p.height)
    }
    for (const f of figures) {
      minX = Math.min(minX, f.x)
      minY = Math.min(minY, f.y)
      maxX = Math.max(maxX, f.x + f.width)
      maxY = Math.max(maxY, f.y + f.height)
    }
    // Add padding
    const pad = 100
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad }
  }, [panels, figures])

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
  const clampedViewportRect = getClampedViewportRect(viewport, bounds, containerWidth, containerHeight)
  const vpRect = {
    x: toMiniX(clampedViewportRect.left),
    y: toMiniY(clampedViewportRect.top),
    w: clampedViewportRect.width * scale,
    h: clampedViewportRect.height * scale,
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

      // Center the viewport on this point (live zoom — a wheel gesture may
      // still be in flight and not yet committed to the store)
      const liveZoom = getLiveViewport().zoom || viewport.zoom
      const newVpX = -(canvasX * liveZoom - containerWidth / 2)
      const newVpY = -(canvasY * liveZoom - containerHeight / 2)
      setViewport({ x: newVpX, y: newVpY, zoom: liveZoom })
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

  const taskStatusMap = useMemo(() => {
    const map = new Map<string, (typeof tasks)[number]['status']>()
    for (const task of tasks) map.set(task.id, task.status)
    return map
  }, [tasks])

  const zoomPercent = Math.round(viewport.zoom * 100)

  // Union box of the drawing figures (canvas space) — merged into the
  // fit-to-content so figures are fitted along with the panels.
  const figuresBounds = useMemo(() => {
    const box = unionBox(figures)
    if (!box) return undefined
    return { minX: box.x, minY: box.y, maxX: box.x + box.width, maxY: box.y + box.height }
  }, [figures])

  // ── Follow the viewport during a gesture, imperatively ──
  // The canvas doesn't write the viewport to the store while the user is
  // panning/zooming (see InfiniteCanvas), so the minimap can't re-render its
  // way there. Track the live viewport and patch the rect/readouts in place —
  // no React render, and the minimap still moves at native refresh rate.
  const vpRectRef = useRef<SVGRectElement>(null)
  const zoomLabelRef = useRef<HTMLSpanElement>(null)
  const zoomSliderRef = useRef<HTMLInputElement>(null)
  // Projection captured during render; only re-derived when the store commits.
  const projectionRef = useRef({ bounds, scale })
  projectionRef.current = { bounds, scale }

  useEffect(() => {
    const applyLiveViewport = (vp: { x: number; y: number; zoom: number }) => {
      const { bounds: currentBounds, scale: s } = projectionRef.current
      const rectEl = vpRectRef.current
      if (rectEl && s > 0 && vp.zoom > 0) {
        const rect = getClampedViewportRect(vp, currentBounds, containerWidth, containerHeight)
        rectEl.setAttribute('x', String(MINIMAP_PAD + (rect.left - currentBounds.minX) * s))
        rectEl.setAttribute('y', String(MINIMAP_PAD + (rect.top - currentBounds.minY) * s))
        rectEl.setAttribute('width', String(Math.max(4, rect.width * s)))
        rectEl.setAttribute('height', String(Math.max(3, rect.height * s)))
      }
      const label = zoomLabelRef.current
      if (label) label.textContent = `${Math.round(vp.zoom * 100)}%`
      const slider = zoomSliderRef.current
      if (slider) slider.value = String(vp.zoom * 100)
    }
    applyLiveViewport(getLiveViewport())
    return subscribeLiveViewport(applyLiveViewport)
  }, [containerWidth, containerHeight, collapsed])

  if (panels.length === 0 && figures.length === 0) return null

  return (
    <div
      className="absolute bottom-4 right-4 z-10 select-none"
      style={{ pointerEvents: 'auto' }}
    >
      {/* Header bar — always visible */}
      <div
        className="flex items-center justify-between px-2 py-1 bg-[var(--canvas-toolbar)] backdrop-blur-sm border border-border/40 rounded-t-lg cursor-pointer"
        style={{ width: MINIMAP_W, borderBottom: collapsed ? undefined : 'none', borderRadius: collapsed ? '8px' : undefined }}
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">
          Map
        </span>
        <div className="flex items-center gap-1">
          <span ref={zoomLabelRef} className="text-[10px] text-muted-foreground/40 tabular-nums">
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
          className="bg-[var(--canvas-bg)] backdrop-blur-sm border border-border/40 border-t-0 rounded-b-lg overflow-hidden"
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
            <MinimapContent
              panels={panels}
              edges={edges}
              figures={figures}
              bounds={bounds}
              scale={scale}
              taskStatusMap={taskStatusMap}
            />

            {/* Viewport rectangle */}
            <rect
              ref={vpRectRef}
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
              ref={zoomSliderRef}
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
              onClick={(e) => { e.stopPropagation(); fitToContent(containerWidth, containerHeight, figuresBounds) }}
              title="Fit all content"
            >
              <Maximize2 className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export const CanvasMinimap = memo(CanvasMinimapComponent)
