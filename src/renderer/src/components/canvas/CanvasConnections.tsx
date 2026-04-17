import { useMemo } from 'react'
import { useCanvasStore, type CanvasPanelData, type CanvasEdge } from '@/stores/canvas-store'
import { X } from 'lucide-react'

/**
 * Renders SVG connection lines between panels.
 * Also renders the in-progress connection line when drawing a new edge.
 *
 * Browser edges get a distinct animated style (pulsing orange gradient)
 * so it's visually clear that an agent has browser access.
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

  // Calculate edge lines with center-to-center positioning
  const edgeLines = useMemo(() => {
    return edges
      .map((edge) => {
        const from = panelMap.get(edge.fromPanelId)
        const to = panelMap.get(edge.toPanelId)
        if (!from || !to) return null
        return {
          id: edge.id,
          x1: from.x + from.width / 2,
          y1: from.y + from.height / 2,
          x2: to.x + to.width / 2,
          y2: to.y + to.height / 2,
          edge,
        }
      })
      .filter(Boolean) as Array<{
      id: string
      x1: number
      y1: number
      x2: number
      y2: number
      edge: CanvasEdge
    }>
  }, [edges, panelMap])

  // In-progress connection line
  const connectingFrom = connectingFromId ? panelMap.get(connectingFromId) : null
  const pendingLine =
    connectingFrom && mouseCanvasPos
      ? {
          x1: connectingFrom.x + connectingFrom.width / 2,
          y1: connectingFrom.y + connectingFrom.height / 2,
          x2: mouseCanvasPos.x,
          y2: mouseCanvasPos.y,
        }
      : null

  if (edgeLines.length === 0 && !pendingLine) return null

  return (
    <svg
      className="absolute inset-0 pointer-events-none"
      style={{ overflow: 'visible', zIndex: 0 }}
    >
      <defs>
        {/* Default edge arrow */}
        <marker
          id="canvas-arrow"
          markerWidth="8"
          markerHeight="6"
          refX="8"
          refY="3"
          orient="auto"
        >
          <path d="M0,0 L8,3 L0,6" fill="none" stroke="rgba(99,102,241,0.5)" strokeWidth="1" />
        </marker>
        <marker
          id="canvas-arrow-pending"
          markerWidth="8"
          markerHeight="6"
          refX="8"
          refY="3"
          orient="auto"
        >
          <path d="M0,0 L8,3 L0,6" fill="none" stroke="rgba(99,102,241,0.3)" strokeWidth="1" />
        </marker>

        {/* Browser edge arrow — orange */}
        <marker
          id="canvas-arrow-browser"
          markerWidth="10"
          markerHeight="8"
          refX="10"
          refY="4"
          orient="auto"
        >
          <path d="M0,0 L10,4 L0,8" fill="none" stroke="rgba(249,115,22,0.7)" strokeWidth="1.5" />
        </marker>

        {/* Browser edge glow gradient */}
        <linearGradient id="browser-edge-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgba(249,115,22,0.6)" />
          <stop offset="50%" stopColor="rgba(251,146,60,0.8)" />
          <stop offset="100%" stopColor="rgba(249,115,22,0.6)" />
        </linearGradient>

        {/* Pulsing glow filter for browser edges */}
        <filter id="browser-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* CSS animation for browser edge pulse */}
      <style>{`
        @keyframes browserEdgePulse {
          0%, 100% { opacity: 0.4; stroke-dashoffset: 0; }
          50% { opacity: 0.8; }
        }
        @keyframes browserEdgeDash {
          to { stroke-dashoffset: -20; }
        }
        .browser-edge-line {
          animation: browserEdgePulse 2s ease-in-out infinite, browserEdgeDash 1s linear infinite;
        }
        .browser-edge-glow {
          animation: browserEdgePulse 2s ease-in-out infinite;
        }
      `}</style>

      {/* Existing edges */}
      {edgeLines.map((line) => {
        const isBrowser = line.edge.edgeType === 'browser'
        return (
          <g key={line.id}>
            {/* Invisible wider line for easier click target */}
            <line
              x1={line.x1}
              y1={line.y1}
              x2={line.x2}
              y2={line.y2}
              stroke="transparent"
              strokeWidth="14"
              className="pointer-events-auto cursor-pointer"
              onClick={() => removeEdge(line.id)}
            />

            {isBrowser ? (
              <>
                {/* Browser edge — glow layer */}
                <line
                  x1={line.x1}
                  y1={line.y1}
                  x2={line.x2}
                  y2={line.y2}
                  stroke="rgba(249,115,22,0.15)"
                  strokeWidth="6"
                  strokeLinecap="round"
                  className="browser-edge-glow"
                  filter="url(#browser-glow)"
                />
                {/* Browser edge — main line */}
                <line
                  x1={line.x1}
                  y1={line.y1}
                  x2={line.x2}
                  y2={line.y2}
                  stroke="url(#browser-edge-gradient)"
                  strokeWidth="2"
                  strokeDasharray="8 4"
                  strokeLinecap="round"
                  markerEnd="url(#canvas-arrow-browser)"
                  className="browser-edge-line"
                />
                {/* Browser icon at midpoint */}
                <BrowserEdgeIcon
                  x={(line.x1 + line.x2) / 2}
                  y={(line.y1 + line.y2) / 2}
                  onDelete={() => removeEdge(line.id)}
                />
              </>
            ) : (
              <>
                {/* Default edge — visible line */}
                <line
                  x1={line.x1}
                  y1={line.y1}
                  x2={line.x2}
                  y2={line.y2}
                  stroke="rgba(99,102,241,0.35)"
                  strokeWidth="1.5"
                  strokeDasharray="6 4"
                  markerEnd="url(#canvas-arrow)"
                />
                {/* Delete button at midpoint */}
                <EdgeDeleteButton
                  x={(line.x1 + line.x2) / 2}
                  y={(line.y1 + line.y2) / 2}
                  onDelete={() => removeEdge(line.id)}
                />
              </>
            )}
          </g>
        )
      })}

      {/* Pending connection line */}
      {pendingLine && (
        <line
          x1={pendingLine.x1}
          y1={pendingLine.y1}
          x2={pendingLine.x2}
          y2={pendingLine.y2}
          stroke="rgba(99,102,241,0.3)"
          strokeWidth="1.5"
          strokeDasharray="4 4"
          markerEnd="url(#canvas-arrow-pending)"
        />
      )}
    </svg>
  )
}

// ── Browser edge icon (globe at midpoint) ─────────────────────

function BrowserEdgeIcon({
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
      className="pointer-events-auto cursor-pointer"
      onClick={(e) => {
        e.stopPropagation()
        onDelete()
      }}
    >
      {/* Background circle with glow */}
      <circle
        cx={x}
        cy={y}
        r="12"
        fill="#1a1208"
        stroke="rgba(249,115,22,0.4)"
        strokeWidth="1.5"
        className="browser-edge-glow"
      />
      {/* Globe icon */}
      <foreignObject x={x - 7} y={y - 7} width="14" height="14">
        <div className="flex items-center justify-center w-full h-full">
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="rgba(249,115,22,0.8)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
        </div>
      </foreignObject>
      {/* Hover: show X */}
      <g className="opacity-0 hover:opacity-100 transition-opacity">
        <circle cx={x + 8} cy={y - 8} r="5" fill="#161b22" stroke="rgba(239,68,68,0.5)" strokeWidth="1" />
        <foreignObject x={x + 5} y={y - 11} width="6" height="6">
          <div className="flex items-center justify-center w-full h-full">
            <X className="h-2 w-2 text-red-400" />
          </div>
        </foreignObject>
      </g>
    </g>
  )
}

// ── Default edge delete button ────────────────────────────────

function EdgeDeleteButton({
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
      onClick={(e) => {
        e.stopPropagation()
        onDelete()
      }}
    >
      <circle cx={x} cy={y} r="8" fill="#161b22" stroke="rgba(99,102,241,0.3)" strokeWidth="1" />
      <foreignObject x={x - 5} y={y - 5} width="10" height="10">
        <div className="flex items-center justify-center w-full h-full">
          <X className="h-2.5 w-2.5 text-red-400" />
        </div>
      </foreignObject>
    </g>
  )
}
