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

// ── Viewport state ─────────────────────────────────────────

export interface Viewport {
  x: number
  y: number
  zoom: number
}

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 3
export const DEFAULT_PANEL_WIDTH = 400
export const DEFAULT_PANEL_HEIGHT = 300

// ── Store ──────────────────────────────────────────────────

interface CanvasState {
  viewport: Viewport
  panels: CanvasPanelData[]
  nextZIndex: number

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
}

let panelCounter = 0

export const useCanvasStore = create<CanvasState>((set, get) => ({
  viewport: { x: 0, y: 0, zoom: 1 },
  panels: [],
  nextZIndex: 1,

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
        // Zoom towards a point: adjust viewport so the point stays fixed
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

    // Point in canvas space that should stay fixed
    const pointX = (clientX - containerRect.left - viewport.x) / viewport.zoom
    const pointY = (clientY - containerRect.top - viewport.y) / viewport.zoom

    // After zoom, recalculate viewport so the same canvas point is under the cursor
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

  removePanel: (id) =>
    set((s) => ({ panels: s.panels.filter((p) => p.id !== id) })),

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

  clearPanels: () => set({ panels: [], nextZIndex: 1 })
}))
