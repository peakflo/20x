/**
 * WebSocket client with auto-reconnect, visibility-based reconnection,
 * and ping/pong heartbeat for reliable mobile connections.
 */
import { getAuthToken } from './auth'

type EventHandler = (payload: unknown) => void

const handlers = new Map<string, Set<EventHandler>>()
let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1000
let hasConnectedBefore = false
let onStatusChange: ((connected: boolean) => void) | null = null
let onReconnect: (() => void) | null = null
let onFirstConnect: (() => void) | null = null

// Ping/pong heartbeat state
const PING_INTERVAL_MS = 15_000
const PONG_TIMEOUT_MS = 5_000
let pingTimer: ReturnType<typeof setInterval> | null = null
let pongTimer: ReturnType<typeof setTimeout> | null = null
let visibilityListenerAdded = false

export function setStatusChangeHandler(fn: (connected: boolean) => void): void {
  onStatusChange = fn
}

export function setReconnectHandler(fn: () => void): void {
  onReconnect = fn
}

export function setFirstConnectHandler(fn: () => void): void {
  onFirstConnect = fn
}

export function connectWebSocket(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const MOBILE_API_PORT = '20620'
  const host = window.location.port !== MOBILE_API_PORT
    ? `${window.location.hostname}:${MOBILE_API_PORT}`
    : window.location.host
  let url = `${protocol}//${host}/ws`
  const token = getAuthToken()
  if (token) url += `?token=${encodeURIComponent(token)}`

  ws = new WebSocket(url)

  ws.onopen = () => {
    console.log('[WS] Connected')
    const isReconnect = hasConnectedBefore
    hasConnectedBefore = true
    reconnectDelay = 1000
    onStatusChange?.(true)
    startHeartbeat()
    if (isReconnect) {
      onReconnect?.()
    } else {
      onFirstConnect?.()
    }
  }

  ws.onmessage = (event) => {
    try {
      const { type, payload } = JSON.parse(event.data)

      // Handle pong responses from server (heartbeat)
      if (type === 'pong') {
        clearPongTimeout()
        return
      }

      const fns = handlers.get(type)
      if (fns) {
        for (const fn of fns) {
          try { fn(payload) } catch (e) { console.error('[WS] handler error:', e) }
        }
      }
    } catch {
      // ignore malformed messages
    }
  }

  ws.onclose = () => {
    console.log('[WS] Disconnected, reconnecting...')
    stopHeartbeat()
    onStatusChange?.(false)
    scheduleReconnect()
  }

  ws.onerror = () => {
    ws?.close()
  }

  // Register visibility listener once so we reconnect immediately when
  // the mobile browser tab/app comes back to the foreground.
  if (!visibilityListenerAdded) {
    visibilityListenerAdded = true
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }
}

export function disconnectWebSocket(): void {
  stopHeartbeat()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  ws?.close()
  ws = null
}

export function onEvent(type: string, handler: EventHandler): () => void {
  if (!handlers.has(type)) handlers.set(type, new Set())
  handlers.get(type)!.add(handler)
  return () => { handlers.get(type)?.delete(handler) }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    reconnectDelay = Math.min(reconnectDelay * 1.5, 10000)
    connectWebSocket()
  }, reconnectDelay)
}

// ── Ping/pong heartbeat ──────────────────────────────────────

function startHeartbeat(): void {
  stopHeartbeat()
  pingTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }))
      // Expect a pong within PONG_TIMEOUT_MS, otherwise force-close
      pongTimer = setTimeout(() => {
        console.warn('[WS] Pong timeout — closing stale connection')
        ws?.close()
      }, PONG_TIMEOUT_MS)
    }
  }, PING_INTERVAL_MS)
}

function stopHeartbeat(): void {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
  clearPongTimeout()
}

function clearPongTimeout(): void {
  if (pongTimer) { clearTimeout(pongTimer); pongTimer = null }
}

// ── Visibility-based reconnection ────────────────────────────

function handleVisibilityChange(): void {
  if (document.hidden) return

  // Page became visible — check connection health
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    console.log('[WS] Page visible — reconnecting immediately')
    // Cancel any pending slow reconnect and connect right away
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    reconnectDelay = 1000
    connectWebSocket()
  } else if (ws.readyState === WebSocket.OPEN) {
    // Connection looks open but may be stale — send an immediate ping to verify
    ws.send(JSON.stringify({ type: 'ping' }))
    clearPongTimeout()
    pongTimer = setTimeout(() => {
      console.warn('[WS] Pong timeout after visibility change — closing stale connection')
      ws?.close()
    }, PONG_TIMEOUT_MS)
  }
}
