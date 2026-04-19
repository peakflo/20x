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
  /** Electron webContentsId for this webview — used to resolve CDP target via IPC */
  webContentsId?: number
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

export type CanvasEdgeType = 'default' | 'browser' | 'terminal'

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

  // Auto-connect proximity state (transient, shown during drag)
  proximityEdge: { fromId: string; toId: string } | null

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
  setProximityEdge: (edge: { fromId: string; toId: string } | null) => void
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
  proximityEdge: null,
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

    // ── Notify agent when a browser/terminal edge connects to a task ──
    if (edgeType === 'browser') {
      notifyAgentOfBrowserConnection(panels, fromPanelId, toPanelId)
    }
    if (edgeType === 'terminal') {
      notifyAgentOfTerminalConnection(panels, fromPanelId, toPanelId)
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
  setProximityEdge: (edge) => set({ proximityEdge: edge }),

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

// ── Auto-connect proximity detection ─────────────────────────

/** Distance threshold (canvas px) for auto-connect proximity */
export const PROXIMITY_THRESHOLD = 80

/**
 * Check if a dragged panel is close enough to a compatible panel for auto-connect.
 * Returns { fromId, toId } of the browser↔task pair, or null.
 * Only browser↔task pairings trigger proximity (not browser↔browser, etc.).
 */
export function detectProximityEdge(
  draggedPanel: CanvasPanelData,
  otherPanels: CanvasPanelData[],
  existingEdges: CanvasEdge[]
): { fromId: string; toId: string } | null {
  // Only browser, terminal, or task panels participate in auto-connect
  if (draggedPanel.type !== 'browser' && draggedPanel.type !== 'terminal' && draggedPanel.type !== 'task') return null

  // Task connects to browser or terminal; browser/terminal connect to task
  const compatibleTypes: CanvasPanelType[] =
    draggedPanel.type === 'task' ? ['browser', 'terminal'] : ['task']
  const dCx = draggedPanel.x + draggedPanel.width / 2
  const dCy = draggedPanel.y + draggedPanel.height / 2

  let bestDist = Infinity
  let bestPanel: CanvasPanelData | null = null

  for (const p of otherPanels) {
    if (!compatibleTypes.includes(p.type)) continue
    // Skip if already connected
    const alreadyConnected = existingEdges.some(
      (e) =>
        (e.fromPanelId === draggedPanel.id && e.toPanelId === p.id) ||
        (e.fromPanelId === p.id && e.toPanelId === draggedPanel.id)
    )
    if (alreadyConnected) continue

    // Distance between panel edges (not centers) — more intuitive
    const pRight = p.x + p.width
    const pBottom = p.y + p.height
    const dRight = draggedPanel.x + draggedPanel.width
    const dBottom = draggedPanel.y + draggedPanel.height

    // Gap between nearest edges
    const gapX = Math.max(0, Math.max(p.x - dRight, draggedPanel.x - pRight))
    const gapY = Math.max(0, Math.max(p.y - dBottom, draggedPanel.y - pBottom))
    const dist = Math.sqrt(gapX * gapX + gapY * gapY)

    // Also check overlapping panels (dist would be 0)
    const effectiveDist = dist === 0
      ? Math.hypot(dCx - (p.x + p.width / 2), dCy - (p.y + p.height / 2)) * 0.1
      : dist

    if (effectiveDist < PROXIMITY_THRESHOLD && effectiveDist < bestDist) {
      bestDist = effectiveDist
      bestPanel = p
    }
  }

  if (!bestPanel) return null

  // Always put task first, browser second for consistent edge direction
  return draggedPanel.type === 'task'
    ? { fromId: draggedPanel.id, toId: bestPanel.id }
    : { fromId: bestPanel.id, toId: draggedPanel.id }
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

  // Read fresh panel data from store — the `panels` parameter is a snapshot from
  // edge creation and may have stale webContentsId from localStorage persistence.
  const freshBrowserPanel = browserPanel
    ? useCanvasStore.getState().panels.find((p) => p.id === browserPanel.id) || browserPanel
    : browserPanel

  console.log('[BrowserEdge] notifyAgentOfBrowserConnection called', {
    fromPanelId, toPanelId,
    fromType: fromPanel?.type, toType: toPanel?.type,
    taskRefId: taskPanel?.refId, browserPanelId: freshBrowserPanel?.id,
    browserUrl: freshBrowserPanel?.url, browserTitle: freshBrowserPanel?.title,
    browserCdpTargetId: freshBrowserPanel?.cdpTargetId,
    browserWebContentsId: freshBrowserPanel?.webContentsId,
  })

  if (!taskPanel?.refId || !browserPanel) {
    console.log('[BrowserEdge] BAIL: no taskPanel.refId or no browserPanel')
    return
  }

  const resolveAndNotify = async () => {
    const [{ useAgentStore }, { agentSessionApi }, { useTaskStore }] = await Promise.all([
      import('./agent-store'),
      import('@/lib/ipc-client'),
      import('./task-store'),
    ])

    const taskId = taskPanel.refId!
    let session = useAgentStore.getState().getSession(taskId)
    console.log('[BrowserEdge] session state', { taskId, sessionId: session?.sessionId, agentId: session?.agentId })

    // If no active session, auto-start or resume the task
    if (!session?.sessionId) {
      const task = useTaskStore.getState().tasks.find((t) => t.id === taskId)
      console.log('[BrowserEdge] no session, looking up task', { taskId, agentId: task?.agent_id, sessionId: task?.session_id })
      if (!task?.agent_id) {
        console.log('[BrowserEdge] BAIL: no agent_id on task')
        return
      }

      const initSession = useAgentStore.getState().initSession
      try {
        if (task.session_id) {
          useAgentStore.getState().clearMessageDedup(taskId)
          initSession(taskId, '', task.agent_id)
          const result = await agentSessionApi.resume(task.agent_id, taskId, task.session_id)
          if (result.ended) {
            initSession(taskId, '', task.agent_id)
            const { sessionId } = await agentSessionApi.start(task.agent_id, taskId)
            initSession(taskId, sessionId, task.agent_id)
          } else {
            initSession(taskId, result.sessionId, task.agent_id)
          }
        } else {
          initSession(taskId, '', task.agent_id)
          const { sessionId } = await agentSessionApi.start(task.agent_id, taskId)
          initSession(taskId, sessionId, task.agent_id)
        }
        session = useAgentStore.getState().getSession(taskId)
        console.log('[BrowserEdge] session after auto-start', { sessionId: session?.sessionId })
      } catch (err) {
        console.error('[BrowserEdge] Failed to auto-start/resume task:', err)
        return
      }
    }

    if (!session?.sessionId) {
      console.log('[BrowserEdge] BAIL: still no sessionId after auto-start attempt')
      return
    }

    // Re-read fresh panel data — webContentsId may have been updated since edge creation
    const bp = useCanvasStore.getState().panels.find((p) => p.id === browserPanel.id) || browserPanel
    const browserTitle = bp.title || 'Browser'
    const browserUrl = bp.url || ''

    // Resolve which agent-browser tab ID (t1, t2, t3...) corresponds to this
    // browser panel's webview. Uses webContentsId for reliable direct lookup.
    let tabId: string | null = null
    const resolveTab = async (attempt: number): Promise<string | null> => {
      const allTargets = await window.electronAPI.browser.getCdpTargets()
      const webviews = allTargets.filter((t) => t.type === 'webview')
      console.log(`[BrowserEdge] resolveTab attempt=${attempt}`, {
        allTargets: allTargets.map((t) => ({ tabId: t.tabId, type: t.type, url: t.url?.slice(0, 60) })),
        webviewsCount: webviews.length,
        browserUrl,
        webContentsId: bp.webContentsId,
      })
      if (webviews.length === 0) return null

      let match: typeof webviews[0] | null = null

      // 1. Best: use webContentsId → getTargetId for exact CDP target, then find its tabId
      if (!match && bp.webContentsId) {
        try {
          const result = await window.electronAPI.browser.getTargetId(bp.webContentsId)
          if (result.targetId) {
            match = allTargets.find((t) => t.id === result.targetId) || null
            if (match) console.log('[BrowserEdge] matched by webContentsId→getTargetId', match.tabId)
          }
        } catch { /* debugger API failed */ }
      }

      // 2. Match by URL
      if (!match && browserUrl) {
        const urlBase = browserUrl.split('?')[0].split('#')[0]
        match = webviews.find((t) => t.url.startsWith(urlBase)) || null
        if (match) console.log('[BrowserEdge] matched by URL', { tabId: match.tabId, matchUrl: match.url?.slice(0, 60) })
      }

      // 3. Last resort — first available webview
      if (!match) {
        match = webviews[0] || null
        if (match) console.log('[BrowserEdge] fallback to first webview', match.tabId)
      }

      return match?.tabId || null
    }

    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        tabId = await resolveTab(attempt)
        if (tabId) break
        console.log(`[BrowserEdge] no tab found, retrying in 1s (attempt ${attempt + 1}/3)`)
        await new Promise((r) => setTimeout(r, 1000))
      }
    } catch (err) {
      console.error('[BrowserEdge] resolveTab error:', err)
    }

    console.log('[BrowserEdge] final result', { tabId, browserTitle, browserUrl })

    if (!tabId) {
      agentSessionApi.send(
        session.sessionId,
        `[System] A browser panel "${browserTitle}" has been connected to your task on the canvas.\n\n` +
        `The browser panel is loading. To connect once ready:\n` +
        `  agent-browser connect ${CDP_PORT}\n` +
        `  agent-browser tab    # find the [webview] target\n` +
        `  agent-browser tab <tN>   # switch to the webview\n\n` +
        `Then use commands normally (open, snapshot, click, etc.).\n` +
        `Do NOT interact with the [page] target — that is the main app window.`,
        taskPanel.refId!,
        session.agentId
      ).catch((err: unknown) => console.error('[Canvas] Failed to notify agent of browser connection:', err))
      return
    }

    agentSessionApi.send(
      session.sessionId,
      `[System] A browser panel "${browserTitle}" has been connected to your task on the canvas. You now have access to control it.\n\n` +
      `To use the browser, run these commands:\n` +
      `  agent-browser connect ${CDP_PORT}\n` +
      `  agent-browser tab ${tabId}\n\n` +
      `Then use commands normally:\n` +
      `  agent-browser open <url>\n` +
      `  agent-browser snapshot -i\n` +
      `  agent-browser click <ref>\n\n` +
      `Do NOT use "agent-browser tab t1" — that is the main app window.\n` +
      `The user can see everything you do in the browser in real time on the canvas.`,
      taskPanel.refId!,
      session.agentId
    ).catch((err: unknown) => console.error('[Canvas] Failed to notify agent of browser connection:', err))
  }

  resolveAndNotify().catch(() => {
    // Silently ignore — can happen in test environments
  })
}

// ── Terminal↔Task edge notification ──────────────────────────

function notifyAgentOfTerminalConnection(
  panels: CanvasPanelData[],
  fromPanelId: string,
  toPanelId: string
) {
  const fromPanel = panels.find((p) => p.id === fromPanelId)
  const toPanel = panels.find((p) => p.id === toPanelId)
  const taskPanel = fromPanel?.type === 'task' ? fromPanel : toPanel?.type === 'task' ? toPanel : null
  const terminalPanel = fromPanel?.type === 'terminal' ? fromPanel : toPanel?.type === 'terminal' ? toPanel : null

  if (!taskPanel?.refId || !terminalPanel) return

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
      if (!task?.agent_id) return

      const initSession = useAgentStore.getState().initSession
      try {
        if (task.session_id) {
          useAgentStore.getState().clearMessageDedup(taskId)
          initSession(taskId, '', task.agent_id)
          const result = await agentSessionApi.resume(task.agent_id, taskId, task.session_id)
          if (result.ended) {
            initSession(taskId, '', task.agent_id)
            const { sessionId } = await agentSessionApi.start(task.agent_id, taskId)
            initSession(taskId, sessionId, task.agent_id)
          } else {
            initSession(taskId, result.sessionId, task.agent_id)
          }
        } else {
          initSession(taskId, '', task.agent_id)
          const { sessionId } = await agentSessionApi.start(task.agent_id, taskId)
          initSession(taskId, sessionId, task.agent_id)
        }
        session = useAgentStore.getState().getSession(taskId)
      } catch (err) {
        console.error('[TerminalEdge] Failed to auto-start/resume task:', err)
        return
      }
    }

    if (!session?.sessionId) return

    // Get the current terminal buffer to include as initial context
    const terminalId = terminalPanel.id
    let bufferPreview = ''
    try {
      const { lines } = await window.electronAPI.terminal.getBuffer(terminalId, 50)
      if (lines.length > 0) {
        bufferPreview = `\n\nCurrent terminal output (last ${lines.length} lines):\n\`\`\`\n${lines.join('\n')}\n\`\`\``
      }
    } catch { /* ignore */ }

    agentSessionApi.send(
      session.sessionId,
      `[System] A terminal panel "${terminalPanel.title}" has been connected to your task on the canvas.\n\n` +
      `You can read the terminal's output log at any time by running:\n` +
      `  read_terminal_log\n\n` +
      `This is a read-only view — you cannot type into this terminal.\n` +
      `The terminal panel ID is: ${terminalId}\n` +
      `Use your own Bash tool for running commands. Use the terminal log to observe output from processes the user is running.` +
      bufferPreview,
      taskPanel.refId!,
      session.agentId
    ).catch((err: unknown) => console.error('[Canvas] Failed to notify agent of terminal connection:', err))
  }

  resolveAndNotify().catch(() => {
    // Silently ignore — can happen in test environments
  })
}
