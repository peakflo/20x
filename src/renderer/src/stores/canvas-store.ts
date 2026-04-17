import { create } from 'zustand'
import { settingsApi } from '@/lib/ipc-client'

const CANVAS_STORAGE_KEY = 'canvas_state'
const CDP_PORT = 19222
let saveTimer: ReturnType<typeof setTimeout> | null = null
const SAVE_DEBOUNCE_MS = 1000

// ── Panel types ────────────────────────────────────────────

export type CanvasPanelType = 'task' | 'transcript' | 'app' | 'webpage' | 'terminal' | 'browser' | 'placeholder'

export interface CanvasPanelData {
  id: string
  type: CanvasPanelType
  /** Reference ID (task ID, session ID, app ID, etc.) */
  refId?: string
  /** URL for webpage panels */
  url?: string
  /** Browser session name (for browser panels) */
  browserSessionId?: string
  /** WebSocket streaming port (for browser panels) */
  streamPort?: number
  /** CDP target ID for this webview — used to connect agent-browser directly */
  cdpTargetId?: string
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

export type CanvasEdgeType = 'default' | 'browser'

export interface CanvasEdge {
  id: string
  fromPanelId: string
  toPanelId: string
  /** Visual style for the edge — 'browser' gets animated pulsing style */
  edgeType?: CanvasEdgeType
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

// ── Persistence shape ─────────────────────────────────────

interface CanvasPersistedState {
  viewport: Viewport
  panels: CanvasPanelData[]
  edges: CanvasEdge[]
  nextZIndex: number
}

interface CanvasState {
  viewport: Viewport
  panels: CanvasPanelData[]
  edges: CanvasEdge[]
  nextZIndex: number

  // Drag state (transient, not persisted)
  draggingPanelId: string | null
  snapGuides: SnapGuide[]

  // Connection drawing state (transient)
  connectingFromId: string | null

  // Persistence
  isLoaded: boolean
  loadCanvas: () => Promise<void>

  // Viewport actions
  setViewport: (viewport: Partial<Viewport>) => void
  panBy: (dx: number, dy: number) => void
  zoomTo: (zoom: number, centerX?: number, centerY?: number) => void
  zoomAtPoint: (delta: number, clientX: number, clientY: number, containerRect: DOMRect) => void
  resetViewport: () => void
  fitToContent: (containerWidth: number, containerHeight: number) => void
  focusPanel: (id: string, containerWidth: number, containerHeight: number) => void

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
  addEdge: (fromPanelId: string, toPanelId: string, edgeType?: CanvasEdgeType) => string
  removeEdge: (id: string) => void
  removeEdgesForPanel: (panelId: string) => void
  setConnectingFromId: (id: string | null) => void
  clearEdges: () => void
}

let panelCounter = 0
let edgeCounter = 0

/** Debounced persist of canvas state to SQLite settings table */
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const { viewport, panels, edges, nextZIndex } = useCanvasStore.getState()
    const data: CanvasPersistedState = { viewport, panels, edges, nextZIndex }
    settingsApi.set(CANVAS_STORAGE_KEY, JSON.stringify(data)).catch((err) => {
      console.error('[Canvas] Failed to persist state:', err)
    })
  }, SAVE_DEBOUNCE_MS)
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  viewport: { x: 0, y: 0, zoom: 1 },
  panels: [],
  edges: [],
  nextZIndex: 1,
  draggingPanelId: null,
  snapGuides: [],
  connectingFromId: null,
  isLoaded: false,

  loadCanvas: async () => {
    try {
      const raw = await settingsApi.get(CANVAS_STORAGE_KEY)
      if (!raw) {
        set({ isLoaded: true })
        return
      }
      const data = JSON.parse(raw) as CanvasPersistedState
      // Restore counters from persisted panel/edge IDs
      for (const p of data.panels) {
        const match = p.id.match(/^panel-(\d+)/)
        if (match) panelCounter = Math.max(panelCounter, parseInt(match[1], 10))
      }
      for (const e of data.edges) {
        const match = e.id.match(/^edge-(\d+)/)
        if (match) edgeCounter = Math.max(edgeCounter, parseInt(match[1], 10))
      }
      set({
        viewport: data.viewport,
        panels: data.panels,
        edges: data.edges,
        nextZIndex: data.nextZIndex,
        isLoaded: true,
      })
    } catch (err) {
      console.error('[Canvas] Failed to load persisted state:', err)
      set({ isLoaded: true })
    }
  },

  setViewport: (partial) => {
    set((s) => ({ viewport: { ...s.viewport, ...partial } }))
    scheduleSave()
  },

  panBy: (dx, dy) => {
    set((s) => ({
      viewport: { ...s.viewport, x: s.viewport.x + dx, y: s.viewport.y + dy }
    }))
    scheduleSave()
  },

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
    scheduleSave()
  },

  zoomAtPoint: (delta, clientX, clientY, containerRect) => {
    const { viewport } = get()
    // Scale zoom factor by delta magnitude for smooth trackpad pinch-to-zoom.
    // Mac trackpads send small deltas (~2-4px) per event; mice send larger (~100px).
    // Clamp the intensity so it never exceeds a ~15% step per event.
    const intensity = Math.min(Math.abs(delta) / 100, 0.15)
    const factor = delta > 0 ? 1 - intensity : 1 + intensity
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewport.zoom * factor))

    const pointX = (clientX - containerRect.left - viewport.x) / viewport.zoom
    const pointY = (clientY - containerRect.top - viewport.y) / viewport.zoom

    const newX = clientX - containerRect.left - pointX * newZoom
    const newY = clientY - containerRect.top - pointY * newZoom

    set({ viewport: { x: newX, y: newY, zoom: newZoom } })
    scheduleSave()
  },

  resetViewport: () => {
    set({ viewport: { x: 0, y: 0, zoom: 1 } })
    scheduleSave()
  },

  fitToContent: (containerWidth: number, containerHeight: number) => {
    const { panels } = get()
    if (panels.length === 0) return
    // Guard against zero-size container (window minimized, being dragged, not laid out yet)
    if (!containerWidth || !containerHeight || containerWidth < 10 || containerHeight < 10) return

    // Calculate bounding box of all panels
    const PAD = 60
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of panels) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x + p.width)
      maxY = Math.max(maxY, p.y + p.height)
    }

    const contentW = maxX - minX + PAD * 2
    const contentH = maxY - minY + PAD * 2
    if (contentW <= 0 || contentH <= 0) return

    // Fit zoom to show all panels (capped at 1x so we never zoom in past 100%)
    const zoom = Math.max(MIN_ZOOM, Math.min(1, containerWidth / contentW, containerHeight / contentH))

    // Center the bounding box in the viewport
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2
    const x = containerWidth / 2 - centerX * zoom
    const y = containerHeight / 2 - centerY * zoom

    // Final safety check — never set NaN/Infinity
    if (!isFinite(x) || !isFinite(y) || !isFinite(zoom)) return

    set({ viewport: { x, y, zoom } })
    scheduleSave()
  },

  focusPanel: (id, containerWidth, containerHeight) => {
    const { panels, nextZIndex } = get()
    const panel = panels.find((p) => p.id === id)
    if (!panel) return
    if (!containerWidth || !containerHeight || containerWidth < 10 || containerHeight < 10) return

    const PAD = 80
    const contentW = panel.width + PAD * 2
    const contentH = panel.height + PAD * 2
    const zoom = Math.max(MIN_ZOOM, Math.min(1, containerWidth / contentW, containerHeight / contentH))

    const centerX = panel.x + panel.width / 2
    const centerY = panel.y + panel.height / 2
    const x = containerWidth / 2 - centerX * zoom
    const y = containerHeight / 2 - centerY * zoom

    if (!isFinite(x) || !isFinite(y) || !isFinite(zoom)) return

    // Bring panel to front too
    set((s) => ({
      viewport: { x, y, zoom },
      panels: s.panels.map((p) => (p.id === id ? { ...p, zIndex: nextZIndex } : p)),
      nextZIndex: nextZIndex + 1,
    }))
    scheduleSave()
  },

  addPanel: (panel) => {
    const id = `panel-${++panelCounter}-${Date.now()}`
    const { nextZIndex } = get()
    set((s) => ({
      panels: [...s.panels, { ...panel, id, zIndex: nextZIndex }],
      nextZIndex: nextZIndex + 1
    }))
    scheduleSave()
    return id
  },

  removePanel: (id) => {
    get().removeEdgesForPanel(id)
    set((s) => ({ panels: s.panels.filter((p) => p.id !== id) }))
    scheduleSave()
  },

  updatePanel: (id, updates) => {
    set((s) => ({
      panels: s.panels.map((p) => (p.id === id ? { ...p, ...updates } : p))
    }))
    scheduleSave()
  },

  bringToFront: (id) => {
    const { nextZIndex } = get()
    set((s) => ({
      panels: s.panels.map((p) => (p.id === id ? { ...p, zIndex: nextZIndex } : p)),
      nextZIndex: nextZIndex + 1
    }))
    scheduleSave()
  },

  clearPanels: () => {
    set({ panels: [], edges: [], nextZIndex: 1 })
    scheduleSave()
  },

  // Drag
  setDraggingPanelId: (id) => set({ draggingPanelId: id }),
  setSnapGuides: (guides) => set({ snapGuides: guides }),

  // Edges
  addEdge: (fromPanelId, toPanelId, edgeType) => {
    const { edges, panels } = get()
    const exists = edges.some(
      (e) =>
        (e.fromPanelId === fromPanelId && e.toPanelId === toPanelId) ||
        (e.fromPanelId === toPanelId && e.toPanelId === fromPanelId)
    )
    if (exists) return ''
    const id = `edge-${++edgeCounter}-${Date.now()}`
    set((s) => ({
      edges: [...s.edges, { id, fromPanelId, toPanelId, edgeType }]
    }))
    scheduleSave()

    // ── Notify agent when a browser edge connects browser↔task ──
    if (edgeType === 'browser') {
      notifyAgentOfBrowserConnection(panels, fromPanelId, toPanelId)
    }

    return id
  },

  removeEdge: (id) => {
    set((s) => ({ edges: s.edges.filter((e) => e.id !== id) }))
    scheduleSave()
  },

  removeEdgesForPanel: (panelId) => {
    set((s) => ({
      edges: s.edges.filter(
        (e) => e.fromPanelId !== panelId && e.toPanelId !== panelId
      )
    }))
    // No scheduleSave here — caller (removePanel) will save
  },

  setConnectingFromId: (id) => set({ connectingFromId: id }),

  clearEdges: () => {
    set({ edges: [] })
    scheduleSave()
  }
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
  const { x, y } = draggingPanel
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

// ── Browser↔Task edge notification ──────────────────────────
// Lazy-imports agent-store and ipc-client to avoid circular deps in tests.

function notifyAgentOfBrowserConnection(
  panels: CanvasPanelData[],
  fromPanelId: string,
  toPanelId: string
) {
  const fromPanel = panels.find((p) => p.id === fromPanelId)
  const toPanel = panels.find((p) => p.id === toPanelId)
  const taskPanel = fromPanel?.type === 'task' ? fromPanel : toPanel?.type === 'task' ? toPanel : null
  const browserPanel = fromPanel?.type === 'browser' ? fromPanel : toPanel?.type === 'browser' ? toPanel : null

  if (!taskPanel?.refId || !browserPanel) return

  // Resolve the CDP target ID for this webview by querying /json/list
  // and matching the browser panel's URL. This is done at notification time
  // so it always picks up the latest target, even if cdpTargetId wasn't stored yet.
  const resolveAndNotify = async () => {
    const [{ useAgentStore }, { agentSessionApi }, { useTaskStore }] = await Promise.all([
      import('./agent-store'),
      import('@/lib/ipc-client'),
      import('./task-store'),
    ])

    const taskId = taskPanel.refId!
    let session = useAgentStore.getState().getSession(taskId)

    // If no active session, auto-start or resume the task
    if (!session?.sessionId) {
      const task = useTaskStore.getState().tasks.find((t) => t.id === taskId)
      if (!task?.agent_id) return // No agent assigned — can't start

      const initSession = useAgentStore.getState().initSession
      try {
        if (task.session_id) {
          // Resume existing session
          useAgentStore.getState().clearMessageDedup(taskId)
          initSession(taskId, '', task.agent_id)
          const result = await agentSessionApi.resume(task.agent_id, taskId, task.session_id)
          if (result.ended) {
            // Session ended — start fresh
            initSession(taskId, '', task.agent_id)
            const { sessionId } = await agentSessionApi.start(task.agent_id, taskId)
            initSession(taskId, sessionId, task.agent_id)
          } else {
            initSession(taskId, result.sessionId, task.agent_id)
          }
        } else {
          // Start new session
          initSession(taskId, '', task.agent_id)
          const { sessionId } = await agentSessionApi.start(task.agent_id, taskId)
          initSession(taskId, sessionId, task.agent_id)
        }
        // Re-fetch the session after start/resume
        session = useAgentStore.getState().getSession(taskId)
      } catch (err) {
        console.error('[Canvas] Failed to auto-start/resume task for browser connection:', err)
        return
      }
    }

    if (!session?.sessionId) return

    const browserTitle = browserPanel.title || 'Browser'
    const browserUrl = browserPanel.url || ''

    // ALWAYS resolve the CDP target ID fresh via IPC (main process queries
    // localhost:19222/json/list — no CORS issues unlike renderer fetch).
    // Stored cdpTargetId goes stale on every app restart (CDP reassigns IDs).
    let cdpTargetId: string | null = null
    try {
      const webviews = await window.electronAPI.browser.getCdpTargets()

      // 1. Check if the stored target ID is still valid
      const storedId = browserPanel.cdpTargetId
      if (storedId && webviews.some((t) => t.id === storedId)) {
        cdpTargetId = storedId
      } else if (browserUrl) {
        // 2. Match by URL
        const urlBase = browserUrl.split('?')[0].split('#')[0]
        const match = webviews.find((t) => t.url.startsWith(urlBase))
        cdpTargetId = match?.id || webviews[0]?.id || null
      } else {
        // 3. No URL — pick first available webview
        cdpTargetId = webviews[0]?.id || null
      }
    } catch { /* IPC query failed */ }

    // SAFETY: Only send connection instructions when we have a confirmed webview target.
    // Without it, agent-browser would default to the main app window and break the UI.
    if (!cdpTargetId) {
      agentSessionApi.send(
        session.sessionId,
        `[System] A browser panel "${browserTitle}" has been connected to your task on the canvas.\n\n` +
        `The browser panel is not loaded yet — the user needs to navigate to a URL first.\n` +
        `Once loaded, you will receive updated connection instructions.\n\n` +
        `IMPORTANT: Do NOT use "agent-browser connect" or "agent-browser open" — ` +
        `that would navigate the main application window. Wait for the direct WebSocket URL.`,
        taskPanel.refId!,
        session.agentId
      ).catch((err: unknown) => console.error('[Canvas] Failed to notify agent of browser connection:', err))
      return
    }

    const wsUrl = `ws://localhost:${CDP_PORT}/devtools/page/${cdpTargetId}`
    agentSessionApi.send(
      session.sessionId,
      `[System] A browser panel "${browserTitle}" has been connected to your task on the canvas. You now have access to control it.\n\n` +
      `CRITICAL: You MUST include --cdp flag on EVERY agent-browser command. Without it, agent-browser targets the main app window and breaks the UI.\n\n` +
      `To connect:\n` +
      `  agent-browser --cdp "${wsUrl}" open about:blank\n\n` +
      `For ALL subsequent commands, always include --cdp:\n` +
      `  agent-browser --cdp "${wsUrl}" snapshot -i\n` +
      `  agent-browser --cdp "${wsUrl}" click <ref>\n` +
      `  agent-browser --cdp "${wsUrl}" type <ref> "text"\n` +
      `  agent-browser --cdp "${wsUrl}" open <url>\n\n` +
      `If commands stop working, kill stale daemons first:\n` +
      `  pkill -f agent-browser; sleep 1\n` +
      `  agent-browser --cdp "${wsUrl}" open about:blank\n\n` +
      `NEVER use agent-browser without --cdp "${wsUrl}" — every single command needs it.\n\n` +
      `The user can see everything you do in the browser in real time on the canvas.`,
      taskPanel.refId!,
      session.agentId
    ).catch((err: unknown) => console.error('[Canvas] Failed to notify agent of browser connection:', err))
  }

  resolveAndNotify().catch(() => {
    // Silently ignore — can happen in test environments
  })
}
