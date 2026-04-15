import { useMemo } from 'react'
import { useCanvasStore, type CanvasPanelData, type CanvasEdge } from '@/stores/canvas-store'
import { X } from 'lucide-react'

/**
 * Renders SVG connection lines between panels.
 * Also renders the in-progress connection line when drawing a new edge.
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
      </defs>

      {/* Existing edges */}
      {edgeLines.map((line) => (
        <g key={line.id}>
          {/* Invisible wider line for easier click target */}
          <line
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
            stroke="transparent"
            strokeWidth="12"
            className="pointer-events-auto cursor-pointer"
            onClick={() => removeEdge(line.id)}
          />
          {/* Visible line */}
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
        </g>
      ))}

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
