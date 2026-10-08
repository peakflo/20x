/**
 * Automatic exponential-backoff retry for provider "at capacity" errors
 * (Codex app-server's `serverOverloaded` code, surfaced as session.lastError
 * e.g. "Selected model is at capacity. Please try a different model.
 * (serverOverloaded)").
 *
 * Today, any session ERROR — including a transient capacity error — stops
 * polling permanently and leaves the task sitting idle until a human
 * intervenes. This module adds a narrow, opt-in exception: when the error
 * message identifies itself as an overload/capacity error, the caller
 * schedules a retry instead of treating it as terminal.
 *
 * Design:
 * - Pure, DI-friendly bookkeeping — no Electron/db dependencies — so backoff
 *   escalation, the attempt cap, and reset-on-recovery can be unit tested in
 *   isolation with fake timers.
 * - One `OverloadRetryTracker` entry per session id. `scheduleRetry()` is the
 *   only way attempts increment; `reset()` (called by the caller once the
 *   session is confirmed busy/working again) is the only way they go back to
 *   zero. A session that keeps hitting the cap without ever recovering stays
 *   capped — it never gets a bonus attempt it didn't earn.
 * - Base cadence is 5 minutes, doubling on every consecutive failure
 *   (5m, 10m, 20m, 40m, ...), capped at MAX_OVERLOAD_RETRY_ATTEMPTS attempts.
 */

/** Base delay before the first automatic retry. */
export const OVERLOAD_RETRY_BASE_DELAY_MS = 5 * 60 * 1000

/** Attempts beyond this are treated as terminal — the error is surfaced normally. */
export const MAX_OVERLOAD_RETRY_ATTEMPTS = 5

/**
 * Matches both Codex's enum code (`serverOverloaded`, as formatted by
 * `codex-app-server-adapter.ts`'s `summarizeAppServerError`: "... (serverOverloaded)")
 * and the plain-English phrase providers use for the same condition
 * ("at capacity", "is overloaded"), so the same detector keeps working if a
 * provider changes how it phrases the message without changing its meaning.
 */
const OVERLOAD_ERROR_PATTERN = /serverOverloaded|at capacity|is overloaded/i

/** True when a session's error message describes a provider capacity/overload error. */
export function isOverloadError(message: string | null | undefined): boolean {
  if (!message) return false
  return OVERLOAD_ERROR_PATTERN.test(message)
}

/**
 * Exponential backoff delay for the given 0-indexed attempt number:
 * attempt 0 -> baseMs, attempt 1 -> 2*baseMs, attempt 2 -> 4*baseMs, ...
 */
export function computeOverloadBackoffMs(attempt: number, baseMs: number = OVERLOAD_RETRY_BASE_DELAY_MS): number {
  return baseMs * 2 ** Math.max(0, attempt)
}

/** Human-readable duration for the retry notice shown to the user. */
export function formatRetryDelay(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'less than a minute'
  if (minutes === 1) return '1 minute'
  if (minutes < 60) return `${minutes} minutes`
  const hours = minutes / 60
  return hours === 1 ? '1 hour' : `${Math.round(hours * 10) / 10} hours`
}

export interface ScheduledOverloadRetry {
  /** 0-indexed attempt number that was just scheduled. */
  attempt: number
  /** Backoff delay in ms before `onRetry` fires. */
  delayMs: number
}

interface TrackerEntry {
  attempts: number
  timer: ReturnType<typeof setTimeout> | null
}

export interface OverloadRetryTrackerDeps {
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}

/**
 * Per-session attempt counter + pending-retry timer. Kept separate from
 * AgentManager's PollingEntry map: PollingEntry is deleted whenever polling
 * stops (exactly what happens while we're waiting out the backoff), so a
 * counter stored there would be wiped before it was ever read.
 */
export class OverloadRetryTracker {
  private readonly entries = new Map<string, TrackerEntry>()
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout

  constructor(deps: OverloadRetryTrackerDeps = {}) {
    this.setTimeoutFn = deps.setTimeout ?? setTimeout
    this.clearTimeoutFn = deps.clearTimeout ?? clearTimeout
  }

  /** Number of consecutive overload failures recorded for this session. */
  getAttempts(sessionId: string): number {
    return this.entries.get(sessionId)?.attempts ?? 0
  }

  /** True while a retry timer is pending for this session. */
  isScheduled(sessionId: string): boolean {
    return this.entries.get(sessionId)?.timer != null
  }

  /**
   * Records an overload failure for `sessionId` and schedules `onRetry` after
   * an exponentially increasing delay. Returns the scheduled attempt/delay,
   * or `null` when `maxAttempts` has already been reached — the caller
   * should then treat the error as terminal (no further retries).
   *
   * Replaces (does not stack) any retry already pending for this session.
   */
  scheduleRetry(
    sessionId: string,
    onRetry: () => void,
    maxAttempts: number = MAX_OVERLOAD_RETRY_ATTEMPTS,
    baseMs: number = OVERLOAD_RETRY_BASE_DELAY_MS
  ): ScheduledOverloadRetry | null {
    const entry = this.entries.get(sessionId) ?? { attempts: 0, timer: null }
    if (entry.timer) {
      this.clearTimeoutFn(entry.timer)
      entry.timer = null
    }

    if (entry.attempts >= maxAttempts) {
      this.entries.set(sessionId, entry)
      return null
    }

    const attempt = entry.attempts
    const delayMs = computeOverloadBackoffMs(attempt, baseMs)
    entry.attempts = attempt + 1
    entry.timer = this.setTimeoutFn(() => {
      const current = this.entries.get(sessionId)
      if (current) current.timer = null
      onRetry()
    }, delayMs)
    this.entries.set(sessionId, entry)
    return { attempt, delayMs }
  }

  /** Clears the attempt count and any pending timer — call once the session recovers. */
  reset(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (entry?.timer) this.clearTimeoutFn(entry.timer)
    this.entries.delete(sessionId)
  }

  /** Cancels a pending timer without resetting the attempt count (e.g. session destroyed). */
  cancel(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry?.timer) return
    this.clearTimeoutFn(entry.timer)
    entry.timer = null
  }
}
