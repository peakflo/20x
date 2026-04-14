import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { InfiniteCanvas } from './InfiniteCanvas'
import { useCanvasStore } from '@/stores/canvas-store'

describe('InfiniteCanvas', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      viewport: { x: 0, y: 0, zoom: 1 },
      panels: [],
      nextZIndex: 1
    })
  })

  afterEach(cleanup)

  it('should render with empty state message', () => {
    render(<InfiniteCanvas />)
    expect(screen.getByText('Infinite Canvas')).toBeTruthy()
    expect(screen.getByText(/Scroll to pan/)).toBeTruthy()
  })

  it('should show zoom controls', () => {
    render(<InfiniteCanvas />)
    expect(screen.getByText('100%')).toBeTruthy()
    expect(screen.getByTitle('Zoom in')).toBeTruthy()
    expect(screen.getByTitle('Zoom out')).toBeTruthy()
    expect(screen.getByTitle('Reset view (Ctrl+0)')).toBeTruthy()
  })

  it('should show Add Panel button', () => {
    render(<InfiniteCanvas />)
    expect(screen.getByText('Add Panel')).toBeTruthy()
  })

  it('should add a panel when Add Panel is clicked', () => {
    render(<InfiniteCanvas />)
    fireEvent.click(screen.getByText('Add Panel'))
    const { panels } = useCanvasStore.getState()
    expect(panels).toHaveLength(1)
    expect(panels[0].title).toBe('Panel 1')
  })

  it('should render panels when they exist', () => {
    useCanvasStore.getState().addPanel({
      type: 'task',
      title: 'My Task Panel',
      x: 100,
      y: 100,
      width: 400,
      height: 300
    })
    render(<InfiniteCanvas />)
    expect(screen.getByText('My Task Panel')).toBeTruthy()
    expect(screen.getByText('Task')).toBeTruthy()
  })

  it('should hide empty state when panels exist', () => {
    useCanvasStore.getState().addPanel({
      type: 'task',
      title: 'Test',
      x: 0,
      y: 0,
      width: 400,
      height: 300
    })
    render(<InfiniteCanvas />)
    expect(screen.queryByText('Infinite Canvas')).toBeNull()
  })

  it('should update zoom display when zoom changes', () => {
    render(<InfiniteCanvas />)
    // Click zoom in
    fireEvent.click(screen.getByTitle('Zoom in'))
    const { viewport } = useCanvasStore.getState()
    expect(viewport.zoom).toBeGreaterThan(1)
    // The text should update (re-render)
    expect(screen.getByText(`${Math.round(viewport.zoom * 100)}%`)).toBeTruthy()
  })

  it('should reset viewport when reset button is clicked', () => {
    // Change viewport first
    useCanvasStore.getState().panBy(200, 300)
    useCanvasStore.getState().zoomTo(2)
    render(<InfiniteCanvas />)
    fireEvent.click(screen.getByTitle('Reset view (Ctrl+0)'))
    const { viewport } = useCanvasStore.getState()
    expect(viewport).toEqual({ x: 0, y: 0, zoom: 1 })
  })
})
