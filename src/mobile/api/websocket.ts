/**
 * WebSocket client with auto-reconnect.
 * Dispatches events to registered handlers.
 */

type EventHandler = (payload: unknown) => void

const handlers = new Map<string, Set<EventHandler>>()
let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1000
let onStatusChange: ((connected: boolean) => void) | null = null

export function setStatusChangeHandler(fn: (connected: boolean) => void): void {
  onStatusChange = fn
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
  const url = `${protocol}//${host}/ws`

  ws = new WebSocket(url)

  ws.onopen = () => {
    console.log('[WS] Connected')
    reconnectDelay = 1000
    onStatusChange?.(true)
  }

  ws.onmessage = (event) => {
    try {
      const { type, payload } = JSON.parse(event.data)
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
    onStatusChange?.(false)
    scheduleReconnect()
  }

  ws.onerror = () => {
    ws?.close()
  }
}

export function disconnectWebSocket(): void {
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
