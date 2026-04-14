import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore, MIN_ZOOM, MAX_ZOOM, calculateSnap, SNAP_GAP } from './canvas-store'
import type { CanvasPanelData } from './canvas-store'

describe('canvas-store', () => {
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

  // ── Viewport ──────────────────────────────────────────────

  describe('viewport', () => {
    it('should have a default viewport of (0, 0, 1)', () => {
      const { viewport } = useCanvasStore.getState()
      expect(viewport).toEqual({ x: 0, y: 0, zoom: 1 })
    })

    it('should pan by delta', () => {
      useCanvasStore.getState().panBy(100, -50)
      const { viewport } = useCanvasStore.getState()
      expect(viewport.x).toBe(100)
      expect(viewport.y).toBe(-50)
    })

    it('should accumulate pans', () => {
      useCanvasStore.getState().panBy(10, 20)
      useCanvasStore.getState().panBy(30, 40)
      const { viewport } = useCanvasStore.getState()
      expect(viewport.x).toBe(40)
      expect(viewport.y).toBe(60)
    })

    it('should clamp zoom to MIN_ZOOM', () => {
      useCanvasStore.getState().zoomTo(0.01)
      const { viewport } = useCanvasStore.getState()
      expect(viewport.zoom).toBe(MIN_ZOOM)
    })

    it('should clamp zoom to MAX_ZOOM', () => {
      useCanvasStore.getState().zoomTo(10)
      const { viewport } = useCanvasStore.getState()
      expect(viewport.zoom).toBe(MAX_ZOOM)
    })

    it('should zoom to a specific level', () => {
      useCanvasStore.getState().zoomTo(1.5)
      expect(useCanvasStore.getState().viewport.zoom).toBe(1.5)
    })

    it('should zoom towards a center point', () => {
      useCanvasStore.getState().zoomTo(2, 100, 100)
      const { viewport } = useCanvasStore.getState()
      expect(viewport.zoom).toBe(2)
      expect(viewport.x).toBe(-100)
      expect(viewport.y).toBe(-100)
    })

    it('should reset viewport', () => {
      useCanvasStore.getState().panBy(500, 300)
      useCanvasStore.getState().zoomTo(2.5)
      useCanvasStore.getState().resetViewport()
      expect(useCanvasStore.getState().viewport).toEqual({ x: 0, y: 0, zoom: 1 })
    })

    it('should zoomAtPoint correctly', () => {
      const containerRect = { left: 0, top: 0, width: 800, height: 600 } as DOMRect
      useCanvasStore.getState().zoomAtPoint(-1, 400, 300, containerRect)
      const { viewport } = useCanvasStore.getState()
      expect(viewport.zoom).toBeGreaterThan(1)
    })
  })

  // ── Panels ────────────────────────────────────────────────

  describe('panels', () => {
    it('should add a panel and return its id', () => {
      const id = useCanvasStore.getState().addPanel({
        type: 'task',
        title: 'Test Task',
        x: 100,
        y: 200,
        width: 400,
        height: 300,
      })
      expect(id).toBeTruthy()
      expect(typeof id).toBe('string')

      const { panels } = useCanvasStore.getState()
      expect(panels).toHaveLength(1)
      expect(panels[0].title).toBe('Test Task')
      expect(panels[0].type).toBe('task')
      expect(panels[0].x).toBe(100)
      expect(panels[0].y).toBe(200)
      expect(panels[0].zIndex).toBe(1)
    })

    it('should assign incrementing zIndex to new panels', () => {
      useCanvasStore.getState().addPanel({ type: 'task', title: 'A', x: 0, y: 0, width: 400, height: 300 })
      useCanvasStore.getState().addPanel({ type: 'transcript', title: 'B', x: 100, y: 100, width: 400, height: 300 })
      const { panels } = useCanvasStore.getState()
      expect(panels[0].zIndex).toBe(1)
      expect(panels[1].zIndex).toBe(2)
    })

    it('should remove a panel', () => {
      const id = useCanvasStore.getState().addPanel({ type: 'app', title: 'App', x: 0, y: 0, width: 400, height: 300 })
      expect(useCanvasStore.getState().panels).toHaveLength(1)
      useCanvasStore.getState().removePanel(id)
      expect(useCanvasStore.getState().panels).toHaveLength(0)
    })

    it('should update a panel', () => {
      const id = useCanvasStore.getState().addPanel({ type: 'task', title: 'Old', x: 0, y: 0, width: 400, height: 300 })
      useCanvasStore.getState().updatePanel(id, { title: 'New', x: 50, width: 500 })
      const panel = useCanvasStore.getState().panels[0]
      expect(panel.title).toBe('New')
      expect(panel.x).toBe(50)
      expect(panel.width).toBe(500)
      expect(panel.y).toBe(0)
    })

    it('should bring a panel to front', () => {
      const id1 = useCanvasStore.getState().addPanel({ type: 'task', title: 'A', x: 0, y: 0, width: 400, height: 300 })
      useCanvasStore.getState().addPanel({ type: 'task', title: 'B', x: 100, y: 100, width: 400, height: 300 })
      useCanvasStore.getState().bringToFront(id1)
      const panels = useCanvasStore.getState().panels
      const panelA = panels.find((p) => p.id === id1)!
      expect(panelA.zIndex).toBe(3)
    })

    it('should clear all panels and edges', () => {
      const id1 = useCanvasStore.getState().addPanel({ type: 'task', title: 'A', x: 0, y: 0, width: 400, height: 300 })
      const id2 = useCanvasStore.getState().addPanel({ type: 'task', title: 'B', x: 100, y: 100, width: 400, height: 300 })
      useCanvasStore.getState().addEdge(id1, id2)
      useCanvasStore.getState().clearPanels()
      expect(useCanvasStore.getState().panels).toHaveLength(0)
      expect(useCanvasStore.getState().edges).toHaveLength(0)
      expect(useCanvasStore.getState().nextZIndex).toBe(1)
    })

    it('should remove associated edges when removing a panel', () => {
      const id1 = useCanvasStore.getState().addPanel({ type: 'task', title: 'A', x: 0, y: 0, width: 400, height: 300 })
      const id2 = useCanvasStore.getState().addPanel({ type: 'task', title: 'B', x: 100, y: 100, width: 400, height: 300 })
      const id3 = useCanvasStore.getState().addPanel({ type: 'task', title: 'C', x: 200, y: 200, width: 400, height: 300 })
      useCanvasStore.getState().addEdge(id1, id2)
      useCanvasStore.getState().addEdge(id2, id3)

      useCanvasStore.getState().removePanel(id2)
      expect(useCanvasStore.getState().panels).toHaveLength(2)
      expect(useCanvasStore.getState().edges).toHaveLength(0) // both edges removed
    })
  })

  // ── Edges ─────────────────────────────────────────────────

  describe('edges', () => {
    it('should add an edge between two panels', () => {
      const id1 = useCanvasStore.getState().addPanel({ type: 'task', title: 'A', x: 0, y: 0, width: 400, height: 300 })
      const id2 = useCanvasStore.getState().addPanel({ type: 'task', title: 'B', x: 500, y: 0, width: 400, height: 300 })
      const edgeId = useCanvasStore.getState().addEdge(id1, id2)
      expect(edgeId).toBeTruthy()
      expect(useCanvasStore.getState().edges).toHaveLength(1)
      expect(useCanvasStore.getState().edges[0].fromPanelId).toBe(id1)
      expect(useCanvasStore.getState().edges[0].toPanelId).toBe(id2)
    })

    it('should not add duplicate edges', () => {
      const id1 = useCanvasStore.getState().addPanel({ type: 'task', title: 'A', x: 0, y: 0, width: 400, height: 300 })
      const id2 = useCanvasStore.getState().addPanel({ type: 'task', title: 'B', x: 500, y: 0, width: 400, height: 300 })
      useCanvasStore.getState().addEdge(id1, id2)
      const dupId = useCanvasStore.getState().addEdge(id1, id2)
      expect(dupId).toBe('')
      expect(useCanvasStore.getState().edges).toHaveLength(1)
    })

    it('should not add reverse duplicate edges', () => {
      const id1 = useCanvasStore.getState().addPanel({ type: 'task', title: 'A', x: 0, y: 0, width: 400, height: 300 })
      const id2 = useCanvasStore.getState().addPanel({ type: 'task', title: 'B', x: 500, y: 0, width: 400, height: 300 })
      useCanvasStore.getState().addEdge(id1, id2)
      const dupId = useCanvasStore.getState().addEdge(id2, id1)
      expect(dupId).toBe('')
      expect(useCanvasStore.getState().edges).toHaveLength(1)
    })

    it('should remove an edge', () => {
      const id1 = useCanvasStore.getState().addPanel({ type: 'task', title: 'A', x: 0, y: 0, width: 400, height: 300 })
      const id2 = useCanvasStore.getState().addPanel({ type: 'task', title: 'B', x: 500, y: 0, width: 400, height: 300 })
      const edgeId = useCanvasStore.getState().addEdge(id1, id2)
      useCanvasStore.getState().removeEdge(edgeId)
      expect(useCanvasStore.getState().edges).toHaveLength(0)
    })

    it('should clear all edges', () => {
      const id1 = useCanvasStore.getState().addPanel({ type: 'task', title: 'A', x: 0, y: 0, width: 400, height: 300 })
      const id2 = useCanvasStore.getState().addPanel({ type: 'task', title: 'B', x: 500, y: 0, width: 400, height: 300 })
      const id3 = useCanvasStore.getState().addPanel({ type: 'task', title: 'C', x: 0, y: 500, width: 400, height: 300 })
      useCanvasStore.getState().addEdge(id1, id2)
      useCanvasStore.getState().addEdge(id2, id3)
      useCanvasStore.getState().clearEdges()
      expect(useCanvasStore.getState().edges).toHaveLength(0)
    })
  })

  // ── Drag state ────────────────────────────────────────────

  describe('drag state', () => {
    it('should set dragging panel id', () => {
      useCanvasStore.getState().setDraggingPanelId('panel-1')
      expect(useCanvasStore.getState().draggingPanelId).toBe('panel-1')
    })

    it('should clear dragging panel id', () => {
      useCanvasStore.getState().setDraggingPanelId('panel-1')
      useCanvasStore.getState().setDraggingPanelId(null)
      expect(useCanvasStore.getState().draggingPanelId).toBeNull()
    })

    it('should set snap guides', () => {
      useCanvasStore.getState().setSnapGuides([
        { axis: 'x', position: 100 },
        { axis: 'y', position: 200 },
      ])
      expect(useCanvasStore.getState().snapGuides).toHaveLength(2)
    })
  })

  // ── Connect state ─────────────────────────────────────────

  describe('connect state', () => {
    it('should set connecting from id', () => {
      useCanvasStore.getState().setConnectingFromId('panel-1')
      expect(useCanvasStore.getState().connectingFromId).toBe('panel-1')
    })

    it('should clear connecting from id', () => {
      useCanvasStore.getState().setConnectingFromId('panel-1')
      useCanvasStore.getState().setConnectingFromId(null)
      expect(useCanvasStore.getState().connectingFromId).toBeNull()
    })
  })

  // ── Snap calculation ──────────────────────────────────────

  describe('calculateSnap', () => {
    const makePanel = (x: number, y: number, w = 400, h = 300): CanvasPanelData => ({
      id: `p-${x}-${y}`,
      type: 'task',
      title: 'Test',
      x,
      y,
      width: w,
      height: h,
      zIndex: 1,
    })

    it('should snap left edge to left edge of another panel', () => {
      const otherPanels = [makePanel(100, 0)]
      const result = calculateSnap({ x: 105, y: 500, width: 400, height: 300 }, otherPanels)
      expect(result.x).toBe(100) // snapped to left=100
      expect(result.guides.some((g) => g.axis === 'x')).toBe(true)
    })

    it('should snap right edge to right edge of another panel', () => {
      const otherPanels = [makePanel(100, 0, 400)]
      // other right = 500, dragging right = x + 400 = 505
      const result = calculateSnap({ x: 105, y: 500, width: 400, height: 300 }, otherPanels)
      // left=100 is closer (dist=5), so left snap wins
      expect(result.x).toBe(100)
    })

    it('should snap with gap between adjacent panels', () => {
      const otherPanels = [makePanel(0, 0, 200)]
      // other right = 200, dragging left should snap to 200 + SNAP_GAP
      const result = calculateSnap({ x: 200 + SNAP_GAP + 3, y: 0, width: 400, height: 300 }, otherPanels)
      expect(result.x).toBe(200 + SNAP_GAP)
    })

    it('should not snap when too far away', () => {
      const otherPanels = [makePanel(0, 0)]
      const result = calculateSnap({ x: 1000, y: 1000, width: 400, height: 300 }, otherPanels)
      expect(result.x).toBe(1000)
      expect(result.y).toBe(1000)
      expect(result.guides).toHaveLength(0)
    })

    it('should snap on both axes independently', () => {
      const otherPanels = [makePanel(100, 200)]
      const result = calculateSnap({ x: 105, y: 205, width: 400, height: 300 }, otherPanels)
      expect(result.x).toBe(100)
      expect(result.y).toBe(200)
      expect(result.guides).toHaveLength(2)
    })
  })
})
