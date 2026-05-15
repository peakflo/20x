import { create } from 'zustand'

// ── Browser session types ────────────────────────────────────

export interface BrowserTab {
  tabId: string
  title: string
  url: string
  active: boolean
}

export interface BrowserSession {
  sessionName: string
  /** WebSocket streaming port (auto-assigned by agent-browser) */
  streamPort: number | null
  /** CDP WebSocket URL */
  cdpUrl: string | null
  /** Whether streaming is active */
  connected: boolean
  /** Whether the browser is screencasting */
  screencasting: boolean
  /** Current viewport dimensions */
  viewportWidth: number
  viewportHeight: number
  /** Open tabs */
  tabs: BrowserTab[]
  /** Current URL */
  currentUrl: string | null
  /** Latest command being executed */
  lastCommand: string | null
  /** WebSocket instance (transient — not persisted) */
  ws: WebSocket | null
  /** Associated canvas panel ID */
  panelId: string | null
  /** Associated task panel ID (for auto-edge creation) */
  linkedTaskPanelId: string | null
}

interface BrowserStoreState {
  sessions: Map<string, BrowserSession>

  // Actions
  createSession: (sessionName: string, panelId: string, linkedTaskPanelId?: string) => BrowserSession
  removeSession: (sessionName: string) => void
  updateSession: (sessionName: string, updates: Partial<BrowserSession>) => void
  getSession: (sessionName: string) => BrowserSession | undefined

  // WebSocket stream connection
  connectStream: (sessionName: string, port: number) => void
  disconnectStream: (sessionName: string) => void
}

export const useBrowserStore = create<BrowserStoreState>((set, get) => ({
  sessions: new Map(),

  createSession: (sessionName, panelId, linkedTaskPanelId) => {
    const session: BrowserSession = {
      sessionName,
      streamPort: null,
      cdpUrl: null,
      connected: false,
      screencasting: false,
      viewportWidth: 1280,
      viewportHeight: 720,
      tabs: [],
      currentUrl: null,
      lastCommand: null,
      ws: null,
      panelId,
      linkedTaskPanelId: linkedTaskPanelId ?? null,
    }
    set((s) => {
      const next = new Map(s.sessions)
      next.set(sessionName, session)
      return { sessions: next }
    })
    return session
  },

  removeSession: (sessionName) => {
    const session = get().sessions.get(sessionName)
    if (session?.ws) {
      session.ws.close()
    }
    set((s) => {
      const next = new Map(s.sessions)
      next.delete(sessionName)
      return { sessions: next }
    })
  },

  updateSession: (sessionName, updates) => {
    set((s) => {
      const existing = s.sessions.get(sessionName)
      if (!existing) return s
      const next = new Map(s.sessions)
      next.set(sessionName, { ...existing, ...updates })
      return { sessions: next }
    })
  },

  getSession: (sessionName) => {
    return get().sessions.get(sessionName)
  },

  connectStream: (sessionName, port) => {
    const { sessions, updateSession } = get()
    const session = sessions.get(sessionName)
    if (!session) return

    // Close existing connection
    if (session.ws) {
      session.ws.close()
    }

    const ws = new WebSocket(`ws://127.0.0.1:${port}`)

    ws.onopen = () => {
      updateSession(sessionName, { connected: true, streamPort: port })
    }

    ws.onmessage = (event) => {
      try {
        const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)
        const msg = JSON.parse(text)

        switch (msg.type) {
          case 'status':
            updateSession(sessionName, {
              connected: msg.connected,
              screencasting: msg.screencasting,
              viewportWidth: msg.viewportWidth,
              viewportHeight: msg.viewportHeight,
            })
            break
          case 'tabs':
            updateSession(sessionName, {
              tabs: msg.tabs?.map((t: BrowserTab) => ({
                tabId: t.tabId,
                title: t.title,
                url: t.url,
                active: t.active,
              })) ?? [],
            })
            break
          case 'url':
            updateSession(sessionName, { currentUrl: msg.url })
            break
          case 'command':
            updateSession(sessionName, { lastCommand: msg.action || msg.params?.action || null })
            break
        }
      } catch {
        // ignore parse errors
      }
    }

    ws.onclose = () => {
      updateSession(sessionName, { connected: false, screencasting: false })
    }

    ws.onerror = () => {
      updateSession(sessionName, { connected: false })
    }

    updateSession(sessionName, { ws, streamPort: port })
  },

  disconnectStream: (sessionName) => {
    const session = get().sessions.get(sessionName)
    if (session?.ws) {
      session.ws.close()
      get().updateSession(sessionName, { ws: null, connected: false })
    }
  },
}))
