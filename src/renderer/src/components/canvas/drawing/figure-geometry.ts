/**
 * Pure geometry helpers for canvas figures. No DOM, no store — everything here
 * is a plain function over canvas-space numbers so it is trivially testable and
 * shared by the rendering layer, hit-testing and the create/move/resize
 * gestures (see docs/drawing.md §4, §6).
 */

import type {
  DrawingObject,
  FigureDirection,
} from './types'

export interface Point {
  x: number
  y: number
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Normalize a drag from start (x1,y1) to end (x2,y2) into a bounding box with
 * non-negative width/height. The box always encloses both points.
 */
export function normalizeBox(x1: number, y1: number, x2: number, y2: number): Box {
  const x = Math.min(x1, x2)
  const y = Math.min(y1, y2)
  return { x, y, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
}

/**
 * Which diagonal of the box does a line/arrow run along, given the drag start
 * and end? The direction names the endpoint relative to the start:
 *   se = end is bottom-right, sw = bottom-left, ne = top-right, nw = top-left.
 */
export function figureDirection(x1: number, y1: number, x2: number, y2: number): FigureDirection {
  const dx = x2 - x1
  const dy = y2 - y1
  if (dx >= 0 && dy >= 0) return 'se'
  if (dx < 0 && dy >= 0) return 'sw'
  if (dx >= 0 && dy < 0) return 'ne'
  return 'nw'
}

/** The two endpoints (from/to) of a line/arrow for a box + direction. */
export function lineEndpoints(box: Box, direction: FigureDirection): { from: Point; to: Point } {
  const tl: Point = { x: box.x, y: box.y }
  const tr: Point = { x: box.x + box.width, y: box.y }
  const bl: Point = { x: box.x, y: box.y + box.height }
  const br: Point = { x: box.x + box.width, y: box.y + box.height }

  switch (direction) {
    case 'se': return { from: tl, to: br }
    case 'sw': return { from: tr, to: bl }
    case 'ne': return { from: bl, to: tr }
    case 'nw': return { from: br, to: tl }
  }
}

export interface ArrowGeometry {
  /** Path `d` for the shaft (stops short of the head so it never pokes through). */
  shaftD: string
  /** Three "x,y" points for the arrowhead <polygon> (tip first). */
  headPoints: string
}

/**
 * Build the shaft + arrowhead geometry for an arrow running from `from` to
 * `to`. The head scales with the stroke width so thin and thick arrows both
 * read correctly.
 */
export function arrowPath(from: Point, to: Point, strokeWidth: number): ArrowGeometry {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy)

  // Degenerate (zero-length) arrow — render just a dot.
  if (len < 0.001) {
    const r = Math.max(2, strokeWidth)
    return {
      shaftD: `M ${from.x} ${from.y} L ${from.x} ${from.y}`,
      headPoints: `${to.x},${to.y} ${to.x - r},${to.y} ${to.x},${to.y - r}`,
    }
  }

  const angle = Math.atan2(dy, dx)
  const headLength = Math.max(10, strokeWidth * 4)
  const headWidth = Math.max(8, strokeWidth * 3)

  const baseX = to.x - headLength * Math.cos(angle)
  const baseY = to.y - headLength * Math.sin(angle)
  const perpX = -Math.sin(angle)
  const perpY = Math.cos(angle)

  const c1x = baseX + (headWidth / 2) * perpX
  const c1y = baseY + (headWidth / 2) * perpY
  const c2x = baseX - (headWidth / 2) * perpX
  const c2y = baseY - (headWidth / 2) * perpY

  return {
    shaftD: `M ${from.x} ${from.y} L ${baseX} ${baseY}`,
    headPoints: `${to.x},${to.y} ${c1x},${c1y} ${c2x},${c2y}`,
  }
}

/** Shortest distance from point `p` to segment `a`–`b`. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const apx = p.x - a.x
  const apy = p.y - a.y
  const abLen2 = abx * abx + aby * aby
  if (abLen2 === 0) return Math.hypot(apx, apy)
  let t = (apx * abx + apy * aby) / abLen2
  t = Math.max(0, Math.min(1, t))
  const projX = a.x + t * abx
  const projY = a.y + t * aby
  return Math.hypot(p.x - projX, p.y - projY)
}

/** Is `p` inside box `box` (expanded by `tolerance` on every side)? */
export function pointInBox(p: Point, box: Box, tolerance = 0): boolean {
  return (
    p.x >= box.x - tolerance &&
    p.x <= box.x + box.width + tolerance &&
    p.y >= box.y - tolerance &&
    p.y <= box.y + box.height + tolerance
  )
}

/**
 * Hit-test a canvas-space point against a single figure. `tolerance` is a
 * canvas-px slack added around the figure's hit region (use ~4 / zoom so thin
 * strokes are still easy to grab).
 */
export function hitTest(p: Point, obj: DrawingObject, tolerance = 4): boolean {
  const box: Box = { x: obj.x, y: obj.y, width: obj.width, height: obj.height }

  switch (obj.type) {
    case 'rectangle':
    case 'text':
    case 'image':
      return pointInBox(p, box, tolerance)

    case 'ellipse': {
      const rx = obj.width / 2 + tolerance
      const ry = obj.height / 2 + tolerance
      if (rx <= 0 || ry <= 0) return false
      const cx = box.x + obj.width / 2
      const cy = box.y + obj.height / 2
      const nx = (p.x - cx) / rx
      const ny = (p.y - cy) / ry
      return nx * nx + ny * ny <= 1
    }

    case 'line':
    case 'arrow': {
      const { from, to } = lineEndpoints(box, obj.direction)
      const slack = tolerance + obj.strokeWidth / 2
      return distanceToSegment(p, from, to) <= slack
    }
  }
}

/**
 * Return the id of the topmost figure under `p`, or null. Figures are tested
 * in descending z-order so the front-most one wins.
 */
export function hitTestObjects(p: Point, objects: DrawingObject[], tolerance = 4): string | null {
  const sorted = [...objects].sort((a, b) => b.zIndex - a.zIndex)
  for (const obj of sorted) {
    if (hitTest(p, obj, tolerance)) return obj.id
  }
  return null
}

/** Union bounding box of a set of figures (for selection outline / fit). */
export function unionBox(objects: DrawingObject[]): Box | null {
  if (objects.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const o of objects) {
    minX = Math.min(minX, o.x)
    minY = Math.min(minY, o.y)
    maxX = Math.max(maxX, o.x + o.width)
    maxY = Math.max(maxY, o.y + o.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}
