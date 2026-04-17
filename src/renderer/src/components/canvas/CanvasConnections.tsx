import { useMemo } from 'react'
import { useCanvasStore, type CanvasPanelData, type CanvasEdge } from '@/stores/canvas-store'

/**
 * Renders smooth bezier connection curves between panels.
 * Follows Figma/React Flow best practice: clean curves, small anchor dots,
 * subtle color distinction for typed edges (browser = orange, default = indigo).
 */
export function CanvasConnections({
  mouseCanvasPos,
}: {
  mouseCanvasPos: { x: number; y: number } | null
}) {
  const panels = useCanvasStore((s) => s.panels)
  const edges = useCanvasStore((s) => s.edges)
  const connectingFromId = useCanvasStore((s) => s.connectingFromId)
  const removeEdge = useCanvasStore((s) => s.removeEdge)

  const panelMap = useMemo(() => {
    const map = new Map<string, CanvasPanelData>()
    for (const p of panels) map.set(p.id, p)
    return map
  }, [panels])

  /**
   * Find the best connection anchor point on a panel edge
   * given a target point — connects from the nearest edge midpoint.
   */
  const getAnchor = (panel: CanvasPanelData, targetX: number, targetY: number) => {
    const cx = panel.x + panel.width / 2
    const cy = panel.y + panel.height / 2
    const dx = targetX - cx
    const dy = targetY - cy

    // Pick the edge that faces the target
    if (Math.abs(dx) / panel.width > Math.abs(dy) / panel.height) {
      // Horizontal — left or right edge
      return dx > 0
        ? { x: panel.x + panel.width, y: cy, dir: 'right' as const }
        : { x: panel.x, y: cy, dir: 'left' as const }
    } else {
      // Vertical — top or bottom edge
      return dy > 0
        ? { x: cx, y: panel.y + panel.height, dir: 'down' as const }
        : { x: cx, y: panel.y, dir: 'up' as const }
    }
  }

  /** Build a smooth cubic bezier path between two anchored points */
  const makePath = (
    from: { x: number; y: number; dir: string },
    to: { x: number; y: number; dir: string }
  ) => {
    const dist = Math.hypot(to.x - from.x, to.y - from.y)
    const offset = Math.min(80, dist * 0.4)

    const cp = (anchor: { x: number; y: number; dir: string }, sign: number) => {
      switch (anchor.dir) {
        case 'right': return { x: anchor.x + offset * sign, y: anchor.y }
        case 'left':  return { x: anchor.x - offset * sign, y: anchor.y }
        case 'down':  return { x: anchor.x, y: anchor.y + offset * sign }
        case 'up':    return { x: anchor.x, y: anchor.y - offset * sign }
        default:      return { x: anchor.x + offset * sign, y: anchor.y }
      }
    }

    const c1 = cp(from, 1)
    const c2 = cp(to, 1)
    return `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`
  }

  // Calculate edge data
  const edgeData = useMemo(() => {
    return edges
      .map((edge) => {
        const from = panelMap.get(edge.fromPanelId)
        const to = panelMap.get(edge.toPanelId)
        if (!from || !to) return null

        const toCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 }
        const fromCenter = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
        const fromAnchor = getAnchor(from, toCenter.x, toCenter.y)
        const toAnchor = getAnchor(to, fromCenter.x, fromCenter.y)
        const path = makePath(fromAnchor, toAnchor)

        return { id: edge.id, edge, fromAnchor, toAnchor, path }
      })
      .filter(Boolean) as Array<{
      id: string
      edge: CanvasEdge
      fromAnchor: { x: number; y: number; dir: string }
      toAnchor: { x: number; y: number; dir: string }
      path: string
    }>
  }, [edges, panelMap])

  // Pending connection line
  const pendingPath = useMemo(() => {
    if (!connectingFromId || !mouseCanvasPos) return null
    const from = panelMap.get(connectingFromId)
    if (!from) return null

    const fromAnchor = getAnchor(from, mouseCanvasPos.x, mouseCanvasPos.y)
    const toAnchor = { ...mouseCanvasPos, dir: fromAnchor.dir === 'right' ? 'left' : fromAnchor.dir === 'left' ? 'right' : fromAnchor.dir === 'down' ? 'up' : 'down' }
    return { fromAnchor, path: makePath(fromAnchor, toAnchor) }
  }, [connectingFromId, mouseCanvasPos, panelMap])

  if (edgeData.length === 0 && !pendingPath) return null

  return (
    <svg
      className="absolute inset-0 pointer-events-none"
      style={{ overflow: 'visible', zIndex: 0 }}
    >
      {/* Existing edges */}
      {edgeData.map((edge) => {
        const isBrowser = edge.edge.edgeType === 'browser'
        const colorFaded = isBrowser ? 'rgba(249,115,22,0.5)' : 'rgba(99,102,241,0.45)'
        const colorDot = isBrowser ? 'rgba(249,115,22,0.8)' : 'rgba(99,102,241,0.7)'

        return (
          <g key={edge.id}>
            {/* Invisible wider path for click target */}
            <path
              d={edge.path}
              fill="none"
              stroke="transparent"
              strokeWidth="14"
              className="pointer-events-auto cursor-pointer"
              onClick={() => removeEdge(edge.id)}
            />

            {/* Visible bezier curve */}
            <path
              d={edge.path}
              fill="none"
              stroke={colorFaded}
              strokeWidth="2"
              strokeLinecap="round"
            />

            {/* Source anchor dot */}
            <circle
              cx={edge.fromAnchor.x}
              cy={edge.fromAnchor.y}
              r="3"
              fill={colorDot}
            />

            {/* Target anchor dot */}
            <circle
              cx={edge.toAnchor.x}
              cy={edge.toAnchor.y}
              r="3"
              fill={colorDot}
            />

            {/* Midpoint label for browser edges */}
            {isBrowser && (
              <EdgeLabel
                path={edge.path}
                onDelete={() => removeEdge(edge.id)}
              />
            )}

            {/* Delete on hover for default edges */}
            {!isBrowser && (
              <EdgeDeleteDot
                x={(edge.fromAnchor.x + edge.toAnchor.x) / 2}
                y={(edge.fromAnchor.y + edge.toAnchor.y) / 2}
                onDelete={() => removeEdge(edge.id)}
              />
            )}
          </g>
        )
      })}

      {/* Pending connection line */}
      {pendingPath && (
        <>
          <path
            d={pendingPath.path}
            fill="none"
            stroke="rgba(99,102,241,0.3)"
            strokeWidth="2"
            strokeDasharray="6 4"
            strokeLinecap="round"
          />
          <circle
            cx={pendingPath.fromAnchor.x}
            cy={pendingPath.fromAnchor.y}
            r="3"
            fill="rgba(99,102,241,0.5)"
          />
          {mouseCanvasPos && (
            <circle
              cx={mouseCanvasPos.x}
              cy={mouseCanvasPos.y}
              r="4"
              fill="none"
              stroke="rgba(99,102,241,0.4)"
              strokeWidth="1.5"
            />
          )}
        </>
      )}
    </svg>
  )
}

// ── Browser edge label (small "Browser" pill at midpoint) ─────

function EdgeLabel({
  path,
  onDelete,
}: {
  path: string
  onDelete: () => void
}) {
  // Approximate midpoint from the path's start and end
  const match = path.match(/M ([\d.-]+) ([\d.-]+) C [\d.-]+[\s,]+[\d.-]+[\s,]+([\d.-]+)[\s,]+([\d.-]+)[\s,]+([\d.-]+)[\s,]+([\d.-]+)/)
  if (!match) return null

  const x1 = parseFloat(match[1]), y1 = parseFloat(match[2])
  const x2 = parseFloat(match[5]), y2 = parseFloat(match[6])
  const mx = (x1 + x2) / 2
  const my = (y1 + y2) / 2

  return (
    <g
      className="pointer-events-auto cursor-pointer"
      onClick={(e) => { e.stopPropagation(); onDelete() }}
    >
      <rect
        x={mx - 28}
        y={my - 9}
        width="56"
        height="18"
        rx="9"
        fill="#1c1208"
        stroke="rgba(249,115,22,0.3)"
        strokeWidth="1"
      />
      <text
        x={mx}
        y={my + 4}
        textAnchor="middle"
        fill="rgba(249,115,22,0.7)"
        fontSize="9"
        fontFamily="system-ui, sans-serif"
        fontWeight="500"
      >
        Browser
      </text>
    </g>
  )
}

// ── Delete dot for default edges (appears on hover) ───────────

function EdgeDeleteDot({
  x,
  y,
  onDelete,
}: {
  x: number
  y: number
  onDelete: () => void
}) {
  return (
    <g
      className="pointer-events-auto cursor-pointer opacity-0 hover:opacity-100 transition-opacity"
      onClick={(e) => { e.stopPropagation(); onDelete() }}
    >
      <circle cx={x} cy={y} r="7" fill="#161b22" stroke="rgba(99,102,241,0.3)" strokeWidth="1" />
      <line x1={x - 2.5} y1={y - 2.5} x2={x + 2.5} y2={y + 2.5} stroke="rgba(239,68,68,0.7)" strokeWidth="1.5" strokeLinecap="round" />
      <line x1={x + 2.5} y1={y - 2.5} x2={x - 2.5} y2={y + 2.5} stroke="rgba(239,68,68,0.7)" strokeWidth="1.5" strokeLinecap="round" />
    </g>
  )
}
