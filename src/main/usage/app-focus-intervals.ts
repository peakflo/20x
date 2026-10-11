/**
 * Writer side of app-focus tracking: how much time the user actually spent
 * with the 20x window focused/visible. This is the denominator of the "my
 * multiplier" headline figure (agent run time ÷ the user's own screen time
 * in the app) — not agent wall-clock time, which is a separate, unaffected
 * stat (peak concurrency, peak-day lanes).
 *
 * Single-user, single-window concern: no session/task/agent identity, just
 * "was the app on screen". See the `app_focus_intervals` section of
 * src/main/database.ts for the schema and the only place its SQL lives.
 */

import type { DatabaseManager } from '../database'

/** Periodic liveness signal while the window stays focused, so a crash mid-session leaves a tightly bounded trail instead of an open-ended one. */
export const FOCUS_HEARTBEAT_INTERVAL_MS = 45_000

/** Call when the main window becomes focused/visible. Idempotent — a duplicate focus signal (e.g. 'show' right after 'focus') is a no-op. */
export function recordFocusGained(db: DatabaseManager, atMs: number): void {
  db.openAppFocusInterval(atMs)
}

/** Call when the main window loses focus, is hidden, or is minimized. Idempotent — a no-op if nothing is open. */
export function recordFocusLost(db: DatabaseManager, atMs: number): void {
  db.closeOpenAppFocusInterval(atMs)
}

/** Call periodically (every `FOCUS_HEARTBEAT_INTERVAL_MS`) while the window stays focused. No-op if nothing is open. */
export function touchFocusHeartbeat(db: DatabaseManager, atMs: number): void {
  db.touchOpenAppFocusInterval(atMs)
}

export interface FocusCrashRecoveryResult {
  recovered: number
}

/**
 * Closes any focus interval left open by a previous run that crashed (or was
 * force-quit) before it could close its own row. Must run synchronously (or
 * be awaited) before anything queries `app_focus_intervals`, and is
 * idempotent. Unlike agent-run crash recovery, there is no "is this session
 * still active" question to ask — a fresh process never inherits a focused
 * window from a previous one, so every open row found here predates the
 * current process.
 *
 * Closes at `lastHeartbeatMs` (touched periodically while focused — see
 * `touchFocusHeartbeat`), clamped to `[startedAtMs, nowMs]`. This bounds the
 * damage of a crash to at most one heartbeat interval of over-counted screen
 * time, instead of leaving the row open (which would otherwise read as
 * "focused" for however long until the next app start) or guessing from
 * unrelated data — there is nothing to backfill focus time from.
 */
export function recoverCrashedFocusIntervals(db: DatabaseManager, nowMs: number): FocusCrashRecoveryResult {
  const open = db.getOpenAppFocusIntervals()
  let recovered = 0
  for (const interval of open) {
    const closeAtMs = Math.min(Math.max(interval.lastHeartbeatMs, interval.startedAtMs), nowMs)
    db.closeAppFocusIntervalById(interval.id, closeAtMs)
    recovered++
  }
  return { recovered }
}
