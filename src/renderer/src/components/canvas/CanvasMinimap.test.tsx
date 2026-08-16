import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { CanvasMinimap } from './CanvasMinimap'
import { useCanvasStore, type CanvasPanelData } from '@/stores/canvas-store'
import { useDrawingStore } from '@/stores/drawing-store'
import type { DrawingObject } from './drawing/types'

const makePanel = (over: Partial<CanvasPanelData> = {}): CanvasPanelData => ({
  id: 'panel-1',
  type: 'task',
  title: 'Task',
  x: 0,
  y: 0,
  width: 200,
  height: 150,
  zIndex: 1,
  ...over,
})

const figureBase = {
  x: 100,
  y: 100,
  width: 100,
  height: 60,
  stroke: '#3b82f6',
  strokeWidth: 2,
  fill: null,
  opacity: 1,
  zIndex: 1,
}

const makeRectFigure = (id: string, over: Partial<typeof figureBase> = {}): DrawingObject =>
  ({ ...figureBase, id, type: 'rectangle', ...over })

const makeTextFigure = (id: string, over: Partial<typeof figureBase> = {}): DrawingObject => ({
  ...figureBase,
  id,
  type: 'text',
  text: 'Hi',
  fontSize: 18,
  fontFamily: 'sans',
  fontWeight: 400,
  textAlign: 'left',
  ...over,
})

const makeLineFigure = (id: string, over: Partial<typeof figureBase> = {}): DrawingObject =>
  ({ ...figureBase, id, type: 'line', direction: 'se', ...over })

describe('CanvasMinimap', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      viewport: { x: 0, y: 0, zoom: 1 },
      panels: [],
      edges: [],
    })
    useDrawingStore.setState({ objects: [] })
  })

  afterEach(cleanup)

  it('renders nothing when there are no panels and no figures', () => {
    const { container } = render(<CanvasMinimap containerWidth={800} containerHeight={600} />)
    expect(container.querySelector('svg')).toBeNull()
  })

  it('shows the minimap and renders figures when there are no panels', () => {
    useDrawingStore.setState({ objects: [makeRectFigure('f1')] })
    const { container } = render(<CanvasMinimap containerWidth={800} containerHeight={600} />)
    expect(container.querySelector('svg')).toBeTruthy()
    const figRect = [...container.querySelectorAll('rect')].find(
      (r) => r.getAttribute('stroke') === '#3b82f6'
    )
    expect(figRect).toBeTruthy()
  })

  it('renders text figures as faint blocks in the text color', () => {
    useDrawingStore.setState({ objects: [makeTextFigure('f1')] })
    const { container } = render(<CanvasMinimap containerWidth={800} containerHeight={600} />)
    const textRect = [...container.querySelectorAll('rect')].find(
      (r) => r.getAttribute('fill') === '#3b82f6' && r.getAttribute('opacity') === '0.3'
    )
    expect(textRect).toBeTruthy()
  })

  it('renders line figures as lines', () => {
    useDrawingStore.setState({ objects: [makeLineFigure('f1')] })
    const { container } = render(<CanvasMinimap containerWidth={800} containerHeight={600} />)
    const line = [...container.querySelectorAll('line')].find(
      (l) => l.getAttribute('stroke') === '#3b82f6'
    )
    expect(line).toBeTruthy()
  })

  it('includes figures in the map bounds (figures far from panels stay visible)', () => {
    useCanvasStore.setState({ panels: [makePanel()] })
    useDrawingStore.setState({
      objects: [makeRectFigure('f1', { x: 2000, y: 1500 })],
    })
    const { container } = render(<CanvasMinimap containerWidth={800} containerHeight={600} />)
    const figRect = [...container.querySelectorAll('rect')].find(
      (r) => r.getAttribute('stroke') === '#3b82f6'
    ) as SVGRectElement
    expect(figRect).toBeTruthy()
    const x = Number(figRect.getAttribute('x'))
    const y = Number(figRect.getAttribute('y'))
    // Inside the minimap's inner area (12px padding on all sides)
    expect(x).toBeGreaterThanOrEqual(12)
    expect(x).toBeLessThanOrEqual(180 - 12)
    expect(y).toBeGreaterThanOrEqual(12)
    expect(y).toBeLessThanOrEqual(120 - 12)
  })
})
