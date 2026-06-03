/**
 * Shared IPC Listener Bus
 *
 * Solves the MaxListenersExceededWarning that occurs when many canvas panels
 * are open — each panel's component tree (TaskWorkspace, WorktreeProgressOverlay,
 * GhCliSetupDialog, HeartbeatSection, etc.) independently registers IPC listeners
 * on the same channels. With 11+ panels, individual channels exceed Node's
 * default limit of 10 listeners.
 *
 * This module registers a SINGLE ipcRenderer.on() listener per channel and
 * fans out events to multiple subscribers via a lightweight pub/sub pattern.
 * Components call subscribe() which returns an unsubscribe function — the
 * same API as the existing on*() helpers in ipc-client.ts.
 */

type Callback<T = unknown> = (data: T) => void

// Per-channel subscriber sets and IPC unsubscribe functions
const subscribers = new Map<string, Set<Callback>>()
const ipcCleanups = new Map<string, () => void>()

/**
 * Ensure a single IPC listener exists for the given channel.
 * The first subscriber triggers registration; removal of the last
 * subscriber tears it down (though in practice channels stay active
 * for the app lifetime).
 */
function ensureListener(
  channel: string,
  registrar: (cb: Callback) => () => void
): void {
  if (ipcCleanups.has(channel)) return

  const handler: Callback = (data) => {
    const subs = subscribers.get(channel)
    if (subs) {
      for (const cb of subs) {
        try {
          cb(data)
        } catch (err) {
          console.error(`[shared-ipc] Error in ${channel} subscriber:`, err)
        }
      }
    }
  }

  const cleanup = registrar(handler)
  ipcCleanups.set(channel, cleanup)
}

/**
 * Subscribe to a shared IPC channel. Returns an unsubscribe function.
 *
 * @param channel  Unique key for this event type (used for dedup)
 * @param registrar  Function that registers the IPC listener (called once per channel)
 * @param callback  Per-component callback
 */
export function subscribe<T>(
  channel: string,
  registrar: (cb: Callback<T>) => () => void,
  callback: Callback<T>
): () => void {
  if (!subscribers.has(channel)) {
    subscribers.set(channel, new Set())
  }

  const subs = subscribers.get(channel)!
  subs.add(callback as Callback)

  // Register the single IPC listener on first subscriber
  ensureListener(channel, registrar as (cb: Callback) => () => void)

  // Return unsubscribe
  return () => {
    subs.delete(callback as Callback)
    // Optionally tear down when no subscribers remain
    // (kept alive to avoid re-registration overhead)
  }
}
