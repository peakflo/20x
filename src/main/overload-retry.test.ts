import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  computeOverloadBackoffMs,
  formatRetryDelay,
  isOverloadError,
  MAX_OVERLOAD_RETRY_ATTEMPTS,
  OVERLOAD_RETRY_BASE_DELAY_MS,
  OverloadRetryTracker
} from './overload-retry'

describe('isOverloadError', () => {
  it('matches the Codex serverOverloaded error code suffix', () => {
    expect(isOverloadError('Selected model is at capacity. Please try a different model. (serverOverloaded)')).toBe(true)
  })

  it('matches a plain-English "at capacity" message without the error code', () => {
    expect(isOverloadError('The model is at capacity right now.')).toBe(true)
  })

  it('matches case-insensitively', () => {
    expect(isOverloadError('SERVER IS OVERLOADED, try again later')).toBe(true)
  })

  it('does not match unrelated errors', () => {
    expect(isOverloadError('Authentication failed: invalid API key')).toBe(false)
    expect(isOverloadError('usage_limit_exceeded')).toBe(false)
    expect(isOverloadError('Session no longer exists on server')).toBe(false)
  })

  it('does not match null/undefined/empty messages', () => {
    expect(isOverloadError(null)).toBe(false)
    expect(isOverloadError(undefined)).toBe(false)
    expect(isOverloadError('')).toBe(false)
  })
})

describe('computeOverloadBackoffMs', () => {
  it('starts at the base 5-minute cadence for the first attempt', () => {
    expect(computeOverloadBackoffMs(0)).toBe(OVERLOAD_RETRY_BASE_DELAY_MS)
    expect(OVERLOAD_RETRY_BASE_DELAY_MS).toBe(5 * 60 * 1000)
  })

  it('doubles on every subsequent attempt', () => {
    expect(computeOverloadBackoffMs(1)).toBe(OVERLOAD_RETRY_BASE_DELAY_MS * 2)
    expect(computeOverloadBackoffMs(2)).toBe(OVERLOAD_RETRY_BASE_DELAY_MS * 4)
    expect(computeOverloadBackoffMs(3)).toBe(OVERLOAD_RETRY_BASE_DELAY_MS * 8)
  })

  it('treats negative attempt numbers as attempt 0', () => {
    expect(computeOverloadBackoffMs(-1)).toBe(OVERLOAD_RETRY_BASE_DELAY_MS)
  })

  it('honors a custom base delay', () => {
    expect(computeOverloadBackoffMs(2, 1000)).toBe(4000)
  })
})

describe('formatRetryDelay', () => {
  it('formats minutes and hours sensibly', () => {
    expect(formatRetryDelay(5 * 60 * 1000)).toBe('5 minutes')
    expect(formatRetryDelay(60 * 1000)).toBe('1 minute')
    expect(formatRetryDelay(20 * 1000)).toBe('less than a minute')
    expect(formatRetryDelay(60 * 60 * 1000)).toBe('1 hour')
  })
})

describe('OverloadRetryTracker', () => {
  let tracker: OverloadRetryTracker

  beforeEach(() => {
    vi.useFakeTimers()
    tracker = new OverloadRetryTracker()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('schedules the first retry at the base 5-minute cadence', () => {
    const onRetry = vi.fn()
    const scheduled = tracker.scheduleRetry('session-1', onRetry)

    expect(scheduled).toEqual({ attempt: 0, delayMs: OVERLOAD_RETRY_BASE_DELAY_MS })
    expect(onRetry).not.toHaveBeenCalled()
    expect(tracker.isScheduled('session-1')).toBe(true)
    expect(tracker.getAttempts('session-1')).toBe(1)

    vi.advanceTimersByTime(OVERLOAD_RETRY_BASE_DELAY_MS)
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(tracker.isScheduled('session-1')).toBe(false)
  })

  it('escalates the backoff exponentially across consecutive overload failures', () => {
    const delays: number[] = []
    for (let i = 0; i < 4; i++) {
      const scheduled = tracker.scheduleRetry('session-1', vi.fn())
      expect(scheduled).not.toBeNull()
      delays.push(scheduled!.delayMs)
      // Simulate the timer firing (without actually invoking onRetry logic,
      // we just need attempts to have been consumed before scheduling again —
      // scheduleRetry itself increments attempts synchronously).
    }

    expect(delays).toEqual([
      OVERLOAD_RETRY_BASE_DELAY_MS,
      OVERLOAD_RETRY_BASE_DELAY_MS * 2,
      OVERLOAD_RETRY_BASE_DELAY_MS * 4,
      OVERLOAD_RETRY_BASE_DELAY_MS * 8
    ])
  })

  it('replaces (does not stack) a pending retry when scheduled again for the same session', () => {
    const firstRetry = vi.fn()
    const secondRetry = vi.fn()
    tracker.scheduleRetry('session-1', firstRetry)
    tracker.scheduleRetry('session-1', secondRetry)

    vi.advanceTimersByTime(OVERLOAD_RETRY_BASE_DELAY_MS * 4)
    expect(firstRetry).not.toHaveBeenCalled()
    expect(secondRetry).toHaveBeenCalledTimes(1)
  })

  it('caps retries at MAX_OVERLOAD_RETRY_ATTEMPTS and returns null beyond the cap', () => {
    const attempts: Array<ReturnType<OverloadRetryTracker['scheduleRetry']>> = []
    for (let i = 0; i < MAX_OVERLOAD_RETRY_ATTEMPTS + 2; i++) {
      attempts.push(tracker.scheduleRetry('session-1', vi.fn()))
    }

    const scheduledCount = attempts.filter((a) => a !== null).length
    expect(scheduledCount).toBe(MAX_OVERLOAD_RETRY_ATTEMPTS)
    expect(attempts[MAX_OVERLOAD_RETRY_ATTEMPTS]).toBeNull()
    expect(attempts[MAX_OVERLOAD_RETRY_ATTEMPTS + 1]).toBeNull()
    expect(tracker.getAttempts('session-1')).toBe(MAX_OVERLOAD_RETRY_ATTEMPTS)
  })

  it('honors a custom maxAttempts override', () => {
    tracker.scheduleRetry('session-1', vi.fn(), 2)
    tracker.scheduleRetry('session-1', vi.fn(), 2)
    const third = tracker.scheduleRetry('session-1', vi.fn(), 2)

    expect(third).toBeNull()
    expect(tracker.getAttempts('session-1')).toBe(2)
  })

  it('resets attempts and cancels the pending timer on recovery', () => {
    const onRetry = vi.fn()
    tracker.scheduleRetry('session-1', onRetry)
    expect(tracker.getAttempts('session-1')).toBe(1)

    tracker.reset('session-1')
    expect(tracker.getAttempts('session-1')).toBe(0)
    expect(tracker.isScheduled('session-1')).toBe(false)

    // The cleared timer must not fire after reset.
    vi.advanceTimersByTime(OVERLOAD_RETRY_BASE_DELAY_MS * 10)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('starts back at the base delay for a new overload after a reset', () => {
    tracker.scheduleRetry('session-1', vi.fn())
    tracker.scheduleRetry('session-1', vi.fn())
    tracker.reset('session-1')

    const scheduled = tracker.scheduleRetry('session-1', vi.fn())
    expect(scheduled).toEqual({ attempt: 0, delayMs: OVERLOAD_RETRY_BASE_DELAY_MS })
  })

  it('cancel() clears the pending timer without resetting the attempt count', () => {
    const onRetry = vi.fn()
    tracker.scheduleRetry('session-1', onRetry)
    tracker.cancel('session-1')

    expect(tracker.isScheduled('session-1')).toBe(false)
    expect(tracker.getAttempts('session-1')).toBe(1)

    vi.advanceTimersByTime(OVERLOAD_RETRY_BASE_DELAY_MS * 10)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('tracks multiple sessions independently', () => {
    tracker.scheduleRetry('session-1', vi.fn())
    tracker.scheduleRetry('session-1', vi.fn())
    tracker.scheduleRetry('session-2', vi.fn())

    expect(tracker.getAttempts('session-1')).toBe(2)
    expect(tracker.getAttempts('session-2')).toBe(1)

    tracker.reset('session-1')
    expect(tracker.getAttempts('session-1')).toBe(0)
    expect(tracker.getAttempts('session-2')).toBe(1)
  })
})
