import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore, MIN_ZOOM, MAX_ZOOM } from './canvas-store'

describe('canvas-store', () => {
  beforeEach(() => {
    // Reset store between tests
    useCanvasStore.setState({
      viewport: { x: 0, y: 0, zoom: 1 },
      panels: [],
      nextZIndex: 1
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
      // The viewport should shift to keep (100, 100) fixed
      expect(viewport.x).toBe(-100) // 100 - (100 - 0) * 2
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
      // Zoom in (negative delta = zoom in) at center of container
      useCanvasStore.getState().zoomAtPoint(-1, 400, 300, containerRect)
      const { viewport } = useCanvasStore.getState()
      expect(viewport.zoom).toBeGreaterThan(1)
      // The point (400, 300) should stay roughly under the cursor
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
        height: 300
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
      expect(panel.y).toBe(0) // unchanged
    })

    it('should bring a panel to front', () => {
      const id1 = useCanvasStore.getState().addPanel({ type: 'task', title: 'A', x: 0, y: 0, width: 400, height: 300 })
      useCanvasStore.getState().addPanel({ type: 'task', title: 'B', x: 100, y: 100, width: 400, height: 300 })
      // Panel A has zIndex 1, B has zIndex 2
      useCanvasStore.getState().bringToFront(id1)
      const panels = useCanvasStore.getState().panels
      const panelA = panels.find((p) => p.id === id1)!
      expect(panelA.zIndex).toBe(3) // nextZIndex was 3
    })

    it('should clear all panels', () => {
      useCanvasStore.getState().addPanel({ type: 'task', title: 'A', x: 0, y: 0, width: 400, height: 300 })
      useCanvasStore.getState().addPanel({ type: 'task', title: 'B', x: 100, y: 100, width: 400, height: 300 })
      useCanvasStore.getState().clearPanels()
      expect(useCanvasStore.getState().panels).toHaveLength(0)
      expect(useCanvasStore.getState().nextZIndex).toBe(1)
    })
  })
})
