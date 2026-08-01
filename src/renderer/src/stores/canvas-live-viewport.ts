import type { Viewport } from './canvas-store'

/**
 * Live canvas viewport — the *authoritative value during a gesture*.
 *
 * While the user pans/zooms, InfiniteCanvas transforms the canvas layer
 * imperatively and does NOT write to the zustand store (a store write commits
 * the whole canvas subtree — grid, connections, minimap and every panel
 * wrapper — on every frame). The store is only updated once, when the gesture
 * ends, so it remains the source of truth at rest.
 *
 * Consumers that must follow the viewport *during* a gesture (the minimap
 * rectangle, the zoom/coordinate readouts) subscribe here and update the DOM
 * imperatively — no React render involved.
 *
 * Invariant: at rest `getLiveViewport()` deep-equals `useCanvasStore.getState().viewport`.
 * InfiniteCanvas re-publishes on every store viewport change to keep that true
 * for programmatic changes (keyboard zoom, focusPanel, minimap navigation…).
 */
let liveViewport: Viewport = { x: 0, y: 0, zoom: 1 }

type LiveViewportListener = (viewport: Viewport) => void
const listeners = new Set<LiveViewportListener>()

export function getLiveViewport(): Viewport {
  return liveViewport
}

export function setLiveViewport(viewport: Viewport): void {
  liveViewport = viewport
  for (const listener of listeners) listener(viewport)
}

export function subscribeLiveViewport(listener: LiveViewportListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
