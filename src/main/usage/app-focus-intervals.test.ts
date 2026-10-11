import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import type { DatabaseManager } from '../database'
import {
  recordFocusGained,
  recordFocusLost,
  touchFocusHeartbeat,
  recoverCrashedFocusIntervals
} from './app-focus-intervals'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0)

let db: DatabaseManager

beforeEach(() => {
  ;({ db } = createTestDb())
})

describe('recordFocusGained / recordFocusLost', () => {
  it('opens an interval on focus gained', () => {
    recordFocusGained(db, BASE)
    const open = db.getOpenAppFocusIntervals()
    expect(open).toHaveLength(1)
    expect(open[0].startedAtMs).toBe(BASE)
    expect(open[0].endedAtMs).toBeNull()
  })

  it('is idempotent: a second focus-gained signal does not open a duplicate row', () => {
    recordFocusGained(db, BASE)
    recordFocusGained(db, BASE + MINUTE)
    expect(db.getOpenAppFocusIntervals()).toHaveLength(1)
    // The original open time is preserved, not overwritten by the second signal.
    expect(db.getOpenAppFocusIntervals()[0].startedAtMs).toBe(BASE)
  })

  it('closes the open interval on focus lost', () => {
    recordFocusGained(db, BASE)
    recordFocusLost(db, BASE + HOUR)
    expect(db.getOpenAppFocusIntervals()).toHaveLength(0)
    const rows = db.getAppFocusIntervalsOverlapping(BASE - HOUR, BASE + 2 * HOUR)
    expect(rows).toHaveLength(1)
    expect(rows[0].endedAtMs).toBe(BASE + HOUR)
  })

  it('is a harmless no-op to close when nothing is open', () => {
    expect(() => recordFocusLost(db, BASE)).not.toThrow()
    expect(db.getAppFocusIntervalsOverlapping(BASE - HOUR, BASE + HOUR)).toHaveLength(0)
  })

  it('supports open -> close -> open again as separate rows', () => {
    recordFocusGained(db, BASE)
    recordFocusLost(db, BASE + HOUR)
    recordFocusGained(db, BASE + 2 * HOUR)
    recordFocusLost(db, BASE + 3 * HOUR)
    const rows = db.getAppFocusIntervalsOverlapping(BASE - HOUR, BASE + 4 * HOUR)
    expect(rows).toHaveLength(2)
  })
})

describe('touchFocusHeartbeat', () => {
  it('updates the open interval last-heartbeat time', () => {
    recordFocusGained(db, BASE)
    touchFocusHeartbeat(db, BASE + 45_000)
    touchFocusHeartbeat(db, BASE + 90_000)
    const open = db.getOpenAppFocusIntervals()[0]
    expect(open.lastHeartbeatMs).toBe(BASE + 90_000)
    // Heartbeat never changes the start time.
    expect(open.startedAtMs).toBe(BASE)
  })

  it('is a no-op when nothing is open', () => {
    expect(() => touchFocusHeartbeat(db, BASE)).not.toThrow()
  })
})

describe('recoverCrashedFocusIntervals', () => {
  it('closes a stale open interval at its last heartbeat time, not startedAtMs', () => {
    recordFocusGained(db, BASE)
    touchFocusHeartbeat(db, BASE + 10 * MINUTE)
    touchFocusHeartbeat(db, BASE + 20 * MINUTE)
    // Crash here — no close call. Simulate app restart far later.
    const result = recoverCrashedFocusIntervals(db, BASE + HOUR)
    expect(result.recovered).toBe(1)
    const rows = db.getAppFocusIntervalsOverlapping(BASE - HOUR, BASE + 2 * HOUR)
    expect(rows).toHaveLength(1)
    expect(rows[0].endedAtMs).toBe(BASE + 20 * MINUTE)
  })

  it('falls back to startedAtMs when no heartbeat ever landed beyond the open time', () => {
    recordFocusGained(db, BASE)
    const result = recoverCrashedFocusIntervals(db, BASE + HOUR)
    expect(result.recovered).toBe(1)
    const rows = db.getAppFocusIntervalsOverlapping(BASE - HOUR, BASE + 2 * HOUR)
    expect(rows[0].endedAtMs).toBe(BASE)
  })

  it('is idempotent: a second run finds nothing left open', () => {
    recordFocusGained(db, BASE)
    const first = recoverCrashedFocusIntervals(db, BASE + HOUR)
    expect(first.recovered).toBe(1)
    const second = recoverCrashedFocusIntervals(db, BASE + 2 * HOUR)
    expect(second.recovered).toBe(0)
  })

  it('never leaves the close time before the start time or after "now"', () => {
    recordFocusGained(db, BASE)
    // nowMs passed to recovery is earlier than a (bogus/future) heartbeat would be — clamp to nowMs.
    touchFocusHeartbeat(db, BASE + 2 * HOUR)
    const result = recoverCrashedFocusIntervals(db, BASE + HOUR)
    expect(result.recovered).toBe(1)
    const rows = db.getAppFocusIntervalsOverlapping(BASE - HOUR, BASE + 3 * HOUR)
    expect(rows[0].endedAtMs).toBe(BASE + HOUR) // clamped to nowMs, not the heartbeat value
  })

  it('does not touch an already-closed interval', () => {
    recordFocusGained(db, BASE)
    recordFocusLost(db, BASE + HOUR)
    const result = recoverCrashedFocusIntervals(db, BASE + 2 * HOUR)
    expect(result.recovered).toBe(0)
    const rows = db.getAppFocusIntervalsOverlapping(BASE - HOUR, BASE + 3 * HOUR)
    expect(rows[0].endedAtMs).toBe(BASE + HOUR)
  })
})
