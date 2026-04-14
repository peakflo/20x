import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { InfiniteCanvas } from './InfiniteCanvas'
import { useCanvasStore } from '@/stores/canvas-store'

// Mock the child components that depend on external stores
vi.mock('@/stores/task-store', () => ({
  useTaskStore: vi.fn((selector) => {
    const state = { tasks: [], selectedTaskId: null, isLoading: false, error: null }
    return selector ? selector(state) : state
  }),
}))

vi.mock('@/stores/agent-store', () => ({
  useAgentStore: vi.fn((selector) => {
    const state = { agents: [], sessions: new Map(), isLoading: false, error: null }
    return selector ? selector(state) : state
  }),
  SessionStatus: { IDLE: 'idle', WORKING: 'working', ERROR: 'error', WAITING_APPROVAL: 'waiting_approval' },
}))

vi.mock('@/stores/ui-store', () => ({
  useUIStore: vi.fn((selector) => {
    const state = {
      canvasPendingTaskId: null,
      clearCanvasPendingTask: vi.fn(),
      sidebarView: 'canvas',
    }
    return selector ? selector(state) : state
  }),
}))

describe('InfiniteCanvas', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      viewport: { x: 0, y: 0, zoom: 1 },
      panels: [],
      edges: [],
      nextZIndex: 1,
      draggingPanelId: null,
      snapGuides: [],
      connectingFromId: null,
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

  it('should render panels when they exist', () => {
    useCanvasStore.getState().addPanel({
      type: 'task',
      title: 'My Task Panel',
      refId: 'task-123',
      x: 100,
      y: 100,
      width: 400,
      height: 300,
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
      height: 300,
    })
    render(<InfiniteCanvas />)
    expect(screen.queryByText('Infinite Canvas')).toBeNull()
  })

  it('should update zoom display when zoom changes', () => {
    render(<InfiniteCanvas />)
    fireEvent.click(screen.getByTitle('Zoom in'))
    const { viewport } = useCanvasStore.getState()
    expect(viewport.zoom).toBeGreaterThan(1)
    expect(screen.getByText(`${Math.round(viewport.zoom * 100)}%`)).toBeTruthy()
  })

  it('should reset viewport when reset button is clicked', () => {
    useCanvasStore.getState().panBy(200, 300)
    useCanvasStore.getState().zoomTo(2)
    render(<InfiniteCanvas />)
    fireEvent.click(screen.getByTitle('Reset view (Ctrl+0)'))
    const { viewport } = useCanvasStore.getState()
    expect(viewport).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  it('should render panels with close buttons', () => {
    useCanvasStore.getState().addPanel({
      type: 'task',
      title: 'Closable Panel',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    })
    render(<InfiniteCanvas />)
    const closeBtn = screen.getByTitle('Close panel')
    expect(closeBtn).toBeTruthy()
  })

  it('should remove panel when close button is clicked', () => {
    useCanvasStore.getState().addPanel({
      type: 'task',
      title: 'To Remove',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    })
    render(<InfiniteCanvas />)
    fireEvent.click(screen.getByTitle('Close panel'))
    expect(useCanvasStore.getState().panels).toHaveLength(0)
  })

  it('should render transcript panel type', () => {
    useCanvasStore.getState().addPanel({
      type: 'transcript',
      title: 'Agent Chat',
      refId: 'task-abc',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    })
    render(<InfiniteCanvas />)
    expect(screen.getByText('Agent Chat')).toBeTruthy()
    expect(screen.getByText('Transcript')).toBeTruthy()
  })

  it('should render app panel type', () => {
    useCanvasStore.getState().addPanel({
      type: 'app',
      title: 'My App',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    })
    render(<InfiniteCanvas />)
    expect(screen.getAllByText('My App').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('App').length).toBeGreaterThanOrEqual(1)
  })

  it('should show connect/collapse/close actions on panel', () => {
    useCanvasStore.getState().addPanel({
      type: 'task',
      title: 'Interactive Panel',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    })
    render(<InfiniteCanvas />)
    expect(screen.getByTitle('Connect to another panel')).toBeTruthy()
    expect(screen.getByTitle('Collapse')).toBeTruthy()
    expect(screen.getByTitle('Close panel')).toBeTruthy()
  })
})
