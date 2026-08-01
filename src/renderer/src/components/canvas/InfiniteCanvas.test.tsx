import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { InfiniteCanvas } from './InfiniteCanvas'
import { useCanvasStore } from '@/stores/canvas-store'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'

const taskStoreState = vi.hoisted(() => ({
  tasks: [] as WorkfloTask[],
  selectedTaskId: null as string | null,
  isLoading: false,
  error: null as string | null,
}))

const makeTask = (overrides: Partial<WorkfloTask> = {}): WorkfloTask => ({
  id: 'task-123',
  title: 'Task',
  description: '',
  type: 'coding',
  priority: 'medium',
  status: TaskStatus.NotStarted,
  assignee: '',
  due_date: null,
  labels: [],
  attachments: [],
  repos: [],
  output_fields: [],
  agent_id: null,
  session_id: null,
  external_id: null,
  source_id: null,
  source: 'manual',
  skill_ids: null,
  snoozed_until: null,
  resolution: null,
  feedback_rating: null,
  feedback_comment: null,
  is_recurring: false,
  recurrence_pattern: null,
  recurrence_parent_id: null,
  last_occurrence_at: null,
  next_occurrence_at: null,
  auto_start_agent: false,
  auto_complete_without_review: false,
  parent_task_id: null,
  sort_order: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

// Mock the child components that depend on external stores
vi.mock('@/stores/task-store', () => ({
  useTaskStore: vi.fn((selector) => {
    return selector ? selector(taskStoreState) : taskStoreState
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
      canvasPendingApp: null,
      clearCanvasPendingApp: vi.fn(),
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
      proximityEdge: null,
      liveDrag: null,
      isLoaded: true, // Skip async load in tests
    })
    taskStoreState.tasks = []
    taskStoreState.selectedTaskId = null
    taskStoreState.isLoading = false
    taskStoreState.error = null
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

  it('uses task status color coding for task panels and minimap rectangles', () => {
    taskStoreState.tasks = [
      makeTask({ id: 'task-123', title: 'Working Task', status: TaskStatus.AgentWorking }),
    ]
    useCanvasStore.getState().addPanel({
      type: 'task',
      title: 'Working Task',
      refId: 'task-123',
      x: 100,
      y: 100,
      width: 400,
      height: 300,
    })

    const { container } = render(<InfiniteCanvas />)

    const statusBadge = screen.getByText('Working')
    expect(statusBadge.className).toContain('text-amber-300')
    const taskPanel = container.querySelector('[data-canvas-panel="true"]')
    expect(taskPanel?.className).toContain('border-amber-500/55')
    expect(container.querySelector('svg rect[fill="rgba(245,158,11,0.86)"]')).toBeTruthy()
  })

  it('shows an off-screen jump popup when a transitioned task is outside the viewport', async () => {
    const originalResizeObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      private callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
      }
      observe() {
        this.callback([{ contentRect: { width: 800, height: 600 } } as ResizeObserverEntry], this as ResizeObserver)
      }
      unobserve() {}
      disconnect() {}
    }

    taskStoreState.tasks = [
      makeTask({ id: 'task-123', title: 'Reviewing Task', status: TaskStatus.AgentWorking }),
    ]
    useCanvasStore.getState().addPanel({
      type: 'task',
      title: 'Reviewing Task',
      refId: 'task-123',
      x: -1000,
      y: 900,
      width: 400,
      height: 300,
    })

    const { container, rerender } = render(<InfiniteCanvas />)
    expect(container.querySelector('[data-canvas-status-edge-highlight="true"]')).toBeNull()

    taskStoreState.tasks = [
      makeTask({ id: 'task-123', title: 'Reviewing Task', status: TaskStatus.ReadyForReview }),
    ]
    rerender(<InfiniteCanvas />)

    await waitFor(() => {
      expect(container.querySelector('[data-canvas-status-edge-highlight="true"]')).toBeTruthy()
    })
    const popup = container.querySelector('[data-canvas-status-edge-highlight="true"]') as HTMLElement
    expect(popup.dataset.direction).toBe('bottom-left')
    expect(parseFloat(popup.style.left)).toBeGreaterThanOrEqual(170)
    expect(popup.querySelector('.lucide-arrow-down-left')).toBeTruthy()

    fireEvent.click(screen.getByTitle('Jump to Reviewing Task'))
    expect(useCanvasStore.getState().viewport.x).not.toBe(0)

    globalThis.ResizeObserver = originalResizeObserver
  })

  it('keeps browser and terminal colors distinct from task status colors', () => {
    useCanvasStore.getState().addPanel({
      type: 'browser',
      title: 'Browser',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    })
    useCanvasStore.getState().addPanel({
      type: 'terminal',
      title: 'Terminal',
      x: 460,
      y: 0,
      width: 400,
      height: 300,
    })

    render(<InfiniteCanvas />)

    expect(screen.getAllByText('Browser')[0].className).toContain('text-orange-300')
    expect(screen.getAllByText('Terminal')[0].className).toContain('text-violet-300')
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

  it('should show focus/collapse/close actions on panel', () => {
    useCanvasStore.getState().addPanel({
      type: 'task',
      title: 'Interactive Panel',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    })
    render(<InfiniteCanvas />)
    expect(screen.getByTitle('Focus panel (zoom to fit)')).toBeTruthy()
    expect(screen.getByTitle('Collapse')).toBeTruthy()
    expect(screen.getByTitle('Close panel')).toBeTruthy()
  })

  // ── Imperative gesture transforms ────────────────────────
  // During a pan/zoom/drag gesture the canvas must do ZERO React work: the
  // DOM is transformed directly and the store is written exactly once, when
  // the gesture ends.

  describe('imperative gesture transforms', () => {
    const flushFrames = async () => {
      // rAF + the queued microtasks React uses to commit
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }

    it('pans the layer imperatively and commits the viewport once the wheel goes idle', async () => {
      const { container } = render(<InfiniteCanvas />)
      const layer = container.querySelector('[data-canvas-transform-layer="true"]') as HTMLElement
      const canvas = layer.parentElement as HTMLElement

      fireEvent.wheel(canvas, { deltaX: 30, deltaY: 40 })
      await flushFrames()

      // DOM moved…
      expect(layer.style.transform).toBe('translate(-30px, -40px) scale(1)')
      expect(layer.style.willChange).toBe('transform')
      // …but the store was NOT written during the gesture.
      expect(useCanvasStore.getState().viewport).toEqual({ x: 0, y: 0, zoom: 1 })

      // Wheel idle → single commit.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200))
      })
      expect(useCanvasStore.getState().viewport).toEqual({ x: -30, y: -40, zoom: 1 })
      expect(layer.style.willChange).toBe('')
    })

    it('commits the viewport on mouseup after a drag-pan', async () => {
      const { container } = render(<InfiniteCanvas />)
      const layer = container.querySelector('[data-canvas-transform-layer="true"]') as HTMLElement
      const canvas = layer.parentElement as HTMLElement

      fireEvent.mouseDown(canvas, { button: 1, clientX: 100, clientY: 100 })
      fireEvent.mouseMove(canvas, { clientX: 150, clientY: 130 })
      await flushFrames()

      expect(layer.style.transform).toBe('translate(50px, 30px) scale(1)')
      expect(useCanvasStore.getState().viewport).toEqual({ x: 0, y: 0, zoom: 1 })

      fireEvent.mouseUp(canvas)
      expect(useCanvasStore.getState().viewport).toEqual({ x: 50, y: 30, zoom: 1 })
    })

    it('keeps the DOM transform in sync with programmatic viewport changes', async () => {
      const { container } = render(<InfiniteCanvas />)
      const layer = container.querySelector('[data-canvas-transform-layer="true"]') as HTMLElement

      await act(async () => {
        useCanvasStore.getState().setViewport({ x: 12, y: 34, zoom: 2 })
      })

      expect(layer.style.transform).toBe('translate(12px, 34px) scale(2)')
    })

    it('moves a dragged panel with a transform and writes x/y only on mouseup', async () => {
      useCanvasStore.getState().addPanel({
        type: 'task',
        title: 'Draggable',
        x: 100,
        y: 100,
        width: 400,
        height: 300,
      })
      const { container } = render(<InfiniteCanvas />)
      const panelEl = container.querySelector('[data-canvas-panel="true"]') as HTMLElement
      const titleBar = panelEl.querySelector('.cursor-grab') as HTMLElement

      fireEvent.mouseDown(titleBar, { button: 0, clientX: 200, clientY: 200 })
      fireEvent.mouseMove(window, { clientX: 260, clientY: 250 })
      await flushFrames()

      // Moved on the compositor, store untouched (left/top still the origin).
      expect(panelEl.style.transform).toBe('translate(60px, 50px)')
      expect(panelEl.style.willChange).toBe('transform')
      expect(useCanvasStore.getState().panels[0]).toMatchObject({ x: 100, y: 100 })

      await act(async () => {
        fireEvent.mouseUp(window)
      })

      expect(useCanvasStore.getState().panels[0]).toMatchObject({ x: 160, y: 150 })
      expect(panelEl.style.transform).toBe('')
      expect(panelEl.style.willChange).toBe('')
    })
  })

  it('keeps canvas content selectable inside panels', () => {
    useCanvasStore.getState().addPanel({
      type: 'task',
      title: 'Selectable Panel',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    })

    const { container } = render(<InfiniteCanvas />)
    const panel = container.querySelector('[data-canvas-panel="true"]')

    expect(panel).toBeTruthy()
    expect(panel?.className).not.toContain('select-none')
  })
})
