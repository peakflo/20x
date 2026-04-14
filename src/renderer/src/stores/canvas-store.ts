import { create } from 'zustand'

// ── Panel types ────────────────────────────────────────────

export type CanvasPanelType = 'task' | 'transcript' | 'app' | 'placeholder'

export interface CanvasPanelData {
  id: string
  type: CanvasPanelType
  /** Reference ID (task ID, session ID, app ID, etc.) */
  refId?: string
  title: string
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  minWidth?: number
  minHeight?: number
}

// ── Connections / Edges ───────────────────────────────────

export interface CanvasEdge {
  id: string
  fromPanelId: string
  toPanelId: string
}

// ── Snapping helpers ──────────────────────────────────────

export const SNAP_THRESHOLD = 12 // px distance to trigger snap
export const SNAP_GAP = 8 // px gap between snapped panels

export interface SnapGuide {
  axis: 'x' | 'y'
  position: number
}

// ── Viewport state ─────────────────────────────────────────

export interface Viewport {
  x: number
  y: number
  zoom: number
}

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 3
export const DEFAULT_PANEL_WIDTH = 1020
export const DEFAULT_PANEL_HEIGHT = 780

// ── Store ──────────────────────────────────────────────────

interface CanvasState {
  viewport: Viewport
  panels: CanvasPanelData[]
  edges: CanvasEdge[]
  nextZIndex: number

  // Drag state
  draggingPanelId: string | null
  snapGuides: SnapGuide[]

  // Connection drawing state
  connectingFromId: string | null

  // Viewport actions
  setViewport: (viewport: Partial<Viewport>) => void
  panBy: (dx: number, dy: number) => void
  zoomTo: (zoom: number, centerX?: number, centerY?: number) => void
  zoomAtPoint: (delta: number, clientX: number, clientY: number, containerRect: DOMRect) => void
  resetViewport: () => void

  // Panel actions
  addPanel: (panel: Omit<CanvasPanelData, 'id' | 'zIndex'>) => string
  removePanel: (id: string) => void
  updatePanel: (id: string, updates: Partial<Omit<CanvasPanelData, 'id'>>) => void
  bringToFront: (id: string) => void
  clearPanels: () => void

  // Drag actions
  setDraggingPanelId: (id: string | null) => void
  setSnapGuides: (guides: SnapGuide[]) => void

  // Edge / connection actions
  addEdge: (fromPanelId: string, toPanelId: string) => string
  removeEdge: (id: string) => void
  removeEdgesForPanel: (panelId: string) => void
  setConnectingFromId: (id: string | null) => void
  clearEdges: () => void
}

let panelCounter = 0
let edgeCounter = 0

export const useCanvasStore = create<CanvasState>((set, get) => ({
  viewport: { x: 0, y: 0, zoom: 1 },
  panels: [],
  edges: [],
  nextZIndex: 1,
  draggingPanelId: null,
  snapGuides: [],
  connectingFromId: null,

  setViewport: (partial) =>
    set((s) => ({ viewport: { ...s.viewport, ...partial } })),

  panBy: (dx, dy) =>
    set((s) => ({
      viewport: { ...s.viewport, x: s.viewport.x + dx, y: s.viewport.y + dy }
    })),

  zoomTo: (zoom, centerX, centerY) => {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
    set((s) => {
      if (centerX !== undefined && centerY !== undefined) {
        const ratio = clamped / s.viewport.zoom
        const newX = centerX - (centerX - s.viewport.x) * ratio
        const newY = centerY - (centerY - s.viewport.y) * ratio
        return { viewport: { x: newX, y: newY, zoom: clamped } }
      }
      return { viewport: { ...s.viewport, zoom: clamped } }
    })
  },

  zoomAtPoint: (delta, clientX, clientY, containerRect) => {
    const { viewport } = get()
    const factor = delta > 0 ? 0.9 : 1.1
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewport.zoom * factor))

    const pointX = (clientX - containerRect.left - viewport.x) / viewport.zoom
    const pointY = (clientY - containerRect.top - viewport.y) / viewport.zoom

    const newX = clientX - containerRect.left - pointX * newZoom
    const newY = clientY - containerRect.top - pointY * newZoom

    set({ viewport: { x: newX, y: newY, zoom: newZoom } })
  },

  resetViewport: () => set({ viewport: { x: 0, y: 0, zoom: 1 } }),

  addPanel: (panel) => {
    const id = `panel-${++panelCounter}-${Date.now()}`
    const { nextZIndex } = get()
    set((s) => ({
      panels: [...s.panels, { ...panel, id, zIndex: nextZIndex }],
      nextZIndex: nextZIndex + 1
    }))
    return id
  },

  removePanel: (id) => {
    // Also remove any edges connected to this panel
    get().removeEdgesForPanel(id)
    set((s) => ({ panels: s.panels.filter((p) => p.id !== id) }))
  },

  updatePanel: (id, updates) =>
    set((s) => ({
      panels: s.panels.map((p) => (p.id === id ? { ...p, ...updates } : p))
    })),

  bringToFront: (id) => {
    const { nextZIndex } = get()
    set((s) => ({
      panels: s.panels.map((p) => (p.id === id ? { ...p, zIndex: nextZIndex } : p)),
      nextZIndex: nextZIndex + 1
    }))
  },

  clearPanels: () => set({ panels: [], edges: [], nextZIndex: 1 }),

  // Drag
  setDraggingPanelId: (id) => set({ draggingPanelId: id }),
  setSnapGuides: (guides) => set({ snapGuides: guides }),

  // Edges
  addEdge: (fromPanelId, toPanelId) => {
    // Don't add duplicate edges
    const { edges } = get()
    const exists = edges.some(
      (e) =>
        (e.fromPanelId === fromPanelId && e.toPanelId === toPanelId) ||
        (e.fromPanelId === toPanelId && e.toPanelId === fromPanelId)
    )
    if (exists) return ''
    const id = `edge-${++edgeCounter}-${Date.now()}`
    set((s) => ({
      edges: [...s.edges, { id, fromPanelId, toPanelId }]
    }))
    return id
  },

  removeEdge: (id) =>
    set((s) => ({ edges: s.edges.filter((e) => e.id !== id) })),

  removeEdgesForPanel: (panelId) =>
    set((s) => ({
      edges: s.edges.filter(
        (e) => e.fromPanelId !== panelId && e.toPanelId !== panelId
      )
    })),

  setConnectingFromId: (id) => set({ connectingFromId: id }),

  clearEdges: () => set({ edges: [] })
}))

// ── Snapping utility ──────────────────────────────────────

/**
 * Calculate snap position and guides for a panel being dragged.
 * Returns adjusted (x, y) and active snap guides.
 */
export function calculateSnap(
  draggingPanel: { x: number; y: number; width: number; height: number },
  otherPanels: CanvasPanelData[],
  threshold = SNAP_THRESHOLD
): { x: number; y: number; guides: SnapGuide[] } {
  let { x, y } = draggingPanel
  const guides: SnapGuide[] = []
  const { width: dw, height: dh } = draggingPanel

  const dLeft = x
  const dRight = x + dw
  const dCenterX = x + dw / 2
  const dTop = y
  const dBottom = y + dh
  const dCenterY = y + dh / 2

  let bestDx = Infinity
  let bestDy = Infinity
  let snapX = x
  let snapY = y
  let guideX: SnapGuide | null = null
  let guideY: SnapGuide | null = null

  for (const p of otherPanels) {
    const pLeft = p.x
    const pRight = p.x + p.width
    const pCenterX = p.x + p.width / 2
    const pTop = p.y
    const pBottom = p.y + p.height
    const pCenterY = p.y + p.height / 2

    // X-axis snapping: left-left, right-right, left-right (with gap), right-left (with gap), center-center
    const xCandidates = [
      { dist: Math.abs(dLeft - pLeft), snap: pLeft, guide: pLeft },
      { dist: Math.abs(dRight - pRight), snap: pRight - dw, guide: pRight },
      { dist: Math.abs(dLeft - (pRight + SNAP_GAP)), snap: pRight + SNAP_GAP, guide: pRight + SNAP_GAP / 2 },
      { dist: Math.abs(dRight - (pLeft - SNAP_GAP)), snap: pLeft - SNAP_GAP - dw, guide: pLeft - SNAP_GAP / 2 },
      { dist: Math.abs(dCenterX - pCenterX), snap: pCenterX - dw / 2, guide: pCenterX },
    ]

    for (const c of xCandidates) {
      if (c.dist < threshold && c.dist < bestDx) {
        bestDx = c.dist
        snapX = c.snap
        guideX = { axis: 'x', position: c.guide }
      }
    }

    // Y-axis snapping: top-top, bottom-bottom, top-bottom (with gap), bottom-top (with gap), center-center
    const yCandidates = [
      { dist: Math.abs(dTop - pTop), snap: pTop, guide: pTop },
      { dist: Math.abs(dBottom - pBottom), snap: pBottom - dh, guide: pBottom },
      { dist: Math.abs(dTop - (pBottom + SNAP_GAP)), snap: pBottom + SNAP_GAP, guide: pBottom + SNAP_GAP / 2 },
      { dist: Math.abs(dBottom - (pTop - SNAP_GAP)), snap: pTop - SNAP_GAP - dh, guide: pTop - SNAP_GAP / 2 },
      { dist: Math.abs(dCenterY - pCenterY), snap: pCenterY - dh / 2, guide: pCenterY },
    ]

    for (const c of yCandidates) {
      if (c.dist < threshold && c.dist < bestDy) {
        bestDy = c.dist
        snapY = c.snap
        guideY = { axis: 'y', position: c.guide }
      }
    }
  }

  if (guideX) guides.push(guideX)
  if (guideY) guides.push(guideY)

  return { x: bestDx < threshold ? snapX : x, y: bestDy < threshold ? snapY : y, guides }
}
