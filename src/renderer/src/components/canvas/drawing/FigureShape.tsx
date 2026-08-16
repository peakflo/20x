import { memo } from 'react'
import type { DrawingObject } from './types'
import { arrowPath, lineEndpoints } from './figure-geometry'

/**
 * Memoized per-figure SVG rendering for shape and image figures (rect,
 * ellipse, line, arrow, image). Text figures render as DOM divs in
 * FigureText instead (contentEditable while editing).
 *
 * The `<g>` carries `data-figure-id` — DrawingLayer uses it for event
 * delegation, imperative move/resize writes, and hit-testing bookkeeping.
 * Thin lines/arrows get an invisible fat-stroke hit path so they stay easy
 * to grab (same trick as the connection edges in CanvasConnections).
 */
export const FigureShape = memo(function FigureShape({ obj }: { obj: DrawingObject }) {
  return (
    <g data-figure-id={obj.id} opacity={obj.opacity} className="pointer-events-auto cursor-move">
      {renderBody(obj)}
    </g>
  )
})

function renderBody(obj: DrawingObject) {
  switch (obj.type) {
    case 'rectangle':
      return (
        <rect
          x={obj.x}
          y={obj.y}
          width={obj.width}
          height={obj.height}
          fill={obj.fill ?? 'none'}
          stroke={obj.stroke}
          strokeWidth={obj.strokeWidth}
        />
      )

    case 'ellipse':
      return (
        <ellipse
          cx={obj.x + obj.width / 2}
          cy={obj.y + obj.height / 2}
          rx={obj.width / 2}
          ry={obj.height / 2}
          fill={obj.fill ?? 'none'}
          stroke={obj.stroke}
          strokeWidth={obj.strokeWidth}
        />
      )

    case 'line': {
      const { from, to } = lineEndpoints(
        { x: obj.x, y: obj.y, width: obj.width, height: obj.height },
        obj.direction
      )
      return (
        <>
          <line
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke={obj.stroke}
            strokeWidth={obj.strokeWidth}
            strokeLinecap="round"
          />
          {/* Invisible fat hit line — thin strokes are hard to grab. */}
          <line
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke="transparent"
            strokeWidth={Math.max(12, obj.strokeWidth + 10)}
            strokeLinecap="round"
            pointerEvents="stroke"
          />
        </>
      )
    }

    case 'arrow': {
      const { from, to } = lineEndpoints(
        { x: obj.x, y: obj.y, width: obj.width, height: obj.height },
        obj.direction
      )
      const geo = arrowPath(from, to, obj.strokeWidth)
      return (
        <>
          <path
            d={geo.shaftD}
            fill="none"
            stroke={obj.stroke}
            strokeWidth={obj.strokeWidth}
            strokeLinecap="round"
          />
          <polygon points={geo.headPoints} fill={obj.stroke} />
          {/* Invisible fat hit line along the whole arrow span. */}
          <line
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke="transparent"
            strokeWidth={Math.max(12, obj.strokeWidth + 10)}
            strokeLinecap="round"
            pointerEvents="stroke"
          />
        </>
      )
    }

    case 'image':
      return (
        <image
          href={obj.src}
          x={obj.x}
          y={obj.y}
          width={obj.width}
          height={obj.height}
          preserveAspectRatio="xMidYMid meet"
        />
      )

    default:
      return null
  }
}
