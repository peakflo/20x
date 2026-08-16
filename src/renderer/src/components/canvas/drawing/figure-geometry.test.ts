import { describe, it, expect } from 'vitest'
import {
  normalizeBox,
  figureDirection,
  lineEndpoints,
  arrowPath,
  distanceToSegment,
  pointInBox,
  hitTest,
  hitTestObjects,
  unionBox,
} from './figure-geometry'
import type { DrawingObject } from './types'

describe('normalizeBox', () => {
  it('normalizes a forward drag', () => {
    expect(normalizeBox(10, 20, 50, 80)).toEqual({ x: 10, y: 20, width: 40, height: 60 })
  })

  it('normalizes a backward drag', () => {
    expect(normalizeBox(50, 80, 10, 20)).toEqual({ x: 10, y: 20, width: 40, height: 60 })
  })

  it('handles a zero-size drag', () => {
    expect(normalizeBox(5, 5, 5, 5)).toEqual({ x: 5, y: 5, width: 0, height: 0 })
  })
})

describe('figureDirection', () => {
  it('se — end is bottom-right of start', () => {
    expect(figureDirection(0, 0, 10, 10)).toBe('se')
  })
  it('sw — end is bottom-left of start', () => {
    expect(figureDirection(10, 0, 0, 10)).toBe('sw')
  })
  it('ne — end is top-right of start', () => {
    expect(figureDirection(0, 10, 10, 0)).toBe('ne')
  })
  it('nw — end is top-left of start', () => {
    expect(figureDirection(10, 10, 0, 0)).toBe('nw')
  })
  it('zero delta counts as se', () => {
    expect(figureDirection(5, 5, 5, 5)).toBe('se')
  })
})

describe('lineEndpoints', () => {
  const box = { x: 0, y: 0, width: 100, height: 50 }

  it('se runs top-left to bottom-right', () => {
    expect(lineEndpoints(box, 'se')).toEqual({
      from: { x: 0, y: 0 },
      to: { x: 100, y: 50 },
    })
  })
  it('sw runs top-right to bottom-left', () => {
    expect(lineEndpoints(box, 'sw')).toEqual({
      from: { x: 100, y: 0 },
      to: { x: 0, y: 50 },
    })
  })
  it('ne runs bottom-left to top-right', () => {
    expect(lineEndpoints(box, 'ne')).toEqual({
      from: { x: 0, y: 50 },
      to: { x: 100, y: 0 },
    })
  })
  it('nw runs bottom-right to top-left', () => {
    expect(lineEndpoints(box, 'nw')).toEqual({
      from: { x: 100, y: 50 },
      to: { x: 0, y: 0 },
    })
  })
})

describe('arrowPath', () => {
  it('shaft stops short of the tip and the head points at the target', () => {
    const geo = arrowPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 2)
    expect(geo.shaftD).toMatch(/^M 0 0 L /)
    const baseX = parseFloat(geo.shaftD.split('L ')[1])
    expect(baseX).toBeGreaterThan(0)
    expect(baseX).toBeLessThan(100)
    expect(geo.headPoints.startsWith('100,0')).toBe(true)
  })

  it('head scales with stroke width', () => {
    const thin = arrowPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 1)
    const thick = arrowPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 8)
    const headSpan = (geo: typeof thin) => {
      const xs = geo.headPoints.split(' ').map((p) => parseFloat(p.split(',')[0]))
      return Math.max(...xs) - Math.min(...xs)
    }
    expect(headSpan(thick)).toBeGreaterThan(headSpan(thin))
  })

  it('a degenerate arrow renders a dot', () => {
    const geo = arrowPath({ x: 5, y: 5 }, { x: 5, y: 5 }, 2)
    expect(geo.shaftD).toBe('M 5 5 L 5 5')
  })
})

describe('distanceToSegment', () => {
  const a = { x: 0, y: 0 }
  const b = { x: 10, y: 0 }

  it('is zero for a point on the segment', () => {
    expect(distanceToSegment({ x: 5, y: 0 }, a, b)).toBe(0)
  })

  it('is the perpendicular offset mid-segment', () => {
    expect(distanceToSegment({ x: 5, y: 3 }, a, b)).toBe(3)
  })

  it('clamps to the nearest endpoint beyond the segment', () => {
    expect(distanceToSegment({ x: 15, y: 0 }, a, b)).toBe(5)
    expect(distanceToSegment({ x: -5, y: 4 }, a, b)).toBe(Math.hypot(5, 4))
  })

  it('handles a zero-length segment', () => {
    expect(distanceToSegment({ x: 3, y: 4 }, a, a)).toBe(5)
  })
})

describe('pointInBox', () => {
  const box = { x: 10, y: 20, width: 100, height: 50 }

  it('detects interior points', () => {
    expect(pointInBox({ x: 50, y: 40 }, box)).toBe(true)
  })

  it('detects boundary points', () => {
    expect(pointInBox({ x: 10, y: 20 }, box)).toBe(true)
    expect(pointInBox({ x: 110, y: 70 }, box)).toBe(true)
  })

  it('rejects exterior points', () => {
    expect(pointInBox({ x: 9, y: 40 }, box)).toBe(false)
    expect(pointInBox({ x: 50, y: 71 }, box)).toBe(false)
  })

  it('expands by the tolerance on every side', () => {
    // Expanded box: x in [8, 112], y in [18, 72]
    expect(pointInBox({ x: 8, y: 40 }, box, 2)).toBe(true)
    expect(pointInBox({ x: 50, y: 71 }, box, 2)).toBe(true)
    expect(pointInBox({ x: 7, y: 40 }, box, 2)).toBe(false)
    expect(pointInBox({ x: 50, y: 73 }, box, 2)).toBe(false)
  })
})

describe('hitTest', () => {
  const rect: DrawingObject = {
    id: 'r',
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    stroke: '#000',
    strokeWidth: 2,
    fill: null,
    opacity: 1,
    zIndex: 1,
  }

  it('hits rectangles inside the box', () => {
    expect(hitTest({ x: 50, y: 25 }, rect)).toBe(true)
    expect(hitTest({ x: 200, y: 25 }, rect)).toBe(false)
  })

  it('hits ellipses inside the curve, not at the box corners', () => {
    const ellipse: DrawingObject = { ...rect, id: 'e', type: 'ellipse' }
    expect(hitTest({ x: 50, y: 25 }, ellipse)).toBe(true)
    expect(hitTest({ x: 5, y: 5 }, ellipse)).toBe(false)
  })

  it('hits lines/arrows near the stroke with tolerance', () => {
    const line: DrawingObject = {
      ...rect,
      id: 'l',
      type: 'line',
      direction: 'se',
      width: 100,
      height: 100,
    }
    // Midpoint of the diagonal (50, 50) — 6px offset is within tolerance.
    expect(hitTest({ x: 50, y: 44 }, line)).toBe(true)
    // Far from the diagonal — outside.
    expect(hitTest({ x: 10, y: 80 }, line, 0)).toBe(false)
  })

  it('respects the stroke width slack for thin lines', () => {
    // Diagonal (0,0)→(100,50); a point 3px off it (perpendicular offset).
    const p = { x: 50 - 3 * 0.44721, y: 25 + 3 * 0.89443 }
    const thin = { ...rect, id: 'thin', type: 'line' as const, direction: 'se' as const, strokeWidth: 2 }
    const thick = { ...rect, id: 't', type: 'line' as const, direction: 'se' as const, strokeWidth: 8 }
    // slack = tolerance + strokeWidth/2 → 1 for thin (miss), 4 for thick (hit).
    expect(hitTest(p, thin, 0)).toBe(false)
    expect(hitTest(p, thick, 0)).toBe(true)
  })
})

describe('hitTestObjects', () => {
  const make = (id: string, x: number, zIndex: number): DrawingObject => ({
    id,
    type: 'rectangle',
    x,
    y: 0,
    width: 100,
    height: 50,
    stroke: '#000',
    strokeWidth: 2,
    fill: null,
    opacity: 1,
    zIndex,
  })

  it('returns the topmost figure under the point', () => {
    const back = make('back', 0, 1)
    const front = make('front', 10, 2)
    expect(hitTestObjects({ x: 50, y: 25 }, [back, front])).toBe('front')
  })

  it('returns null when nothing is hit', () => {
    expect(hitTestObjects({ x: 500, y: 500 }, [make('a', 0, 1)])).toBeNull()
  })

  it('returns null for an empty list', () => {
    expect(hitTestObjects({ x: 0, y: 0 }, [])).toBeNull()
  })
})

describe('unionBox', () => {
  const make = (id: string, x: number, y: number, w: number, h: number): DrawingObject => ({
    id,
    type: 'rectangle',
    x,
    y,
    width: w,
    height: h,
    stroke: '#000',
    strokeWidth: 2,
    fill: null,
    opacity: 1,
    zIndex: 1,
  })

  it('computes the bounding box of several figures', () => {
    expect(unionBox([make('a', 0, 0, 100, 50), make('b', 50, 25, 100, 50)])).toEqual({
      x: 0,
      y: 0,
      width: 150,
      height: 75,
    })
  })

  it('returns null for an empty list', () => {
    expect(unionBox([])).toBeNull()
  })
})
