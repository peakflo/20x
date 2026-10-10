import { describe, it, expect } from 'vitest'
import {
  computeParallelismSummary,
  formatMultiplier,
  periodBoundsForDays,
  type RawAgentRunInterval,
  type RawAppFocusInterval
} from './usage-parallelism'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
// Fixed reference point so nothing here depends on the current date.
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0)

function iv(partial: Partial<RawAgentRunInterval> & { startedAtMs: number; endedAtMs: number | null }): RawAgentRunInterval {
  return {
    sessionId: partial.sessionId ?? `s-${partial.startedAtMs}`,
    taskId: partial.taskId ?? 'task-1',
    agentId: partial.agentId ?? 'agent-1',
    provider: partial.provider ?? 'claude-code',
    harnessInstanceId: partial.harnessInstanceId ?? null,
    startedAtMs: partial.startedAtMs,
    endedAtMs: partial.endedAtMs
  }
}

function focus(startedAtMs: number, endedAtMs: number | null): RawAppFocusInterval {
  return { startedAtMs, endedAtMs }
}

/** A focus interval spanning the whole query period — used in tests that don't care about screen time specifically (peak/lanes/clipping), so `hasData`/`screenTimeMs` still look realistic. */
function fullPeriodFocus(periodStartMs: number, periodEndMs: number): RawAppFocusInterval[] {
  return [focus(periodStartMs, periodEndMs)]
}

describe('computeParallelismSummary — empty / no-data shapes', () => {
  it('returns the "no data" shape for a fully empty period, not 0 or NaN', () => {
    const summary = computeParallelismSummary([], [], BASE, BASE + DAY)
    expect(summary.hasData).toBe(false)
    expect(summary.multiplier).toBeNull()
    expect(summary.peak).toBeNull()
    expect(summary.peakDayLanes).toEqual([])
    expect(summary.totalRunMs).toBe(0)
    expect(summary.wallMs).toBe(0)
    expect(summary.screenTimeMs).toBe(0)
    // Still one row per day for chart alignment, even with no activity.
    expect(summary.perDay).toHaveLength(1)
    expect(summary.perDay[0].runHours).toBe(0)
  })

  it('has agent data (peak/totalRunMs populated) but a null multiplier when there is no screen-time data at all', () => {
    const intervals = [iv({ startedAtMs: BASE, endedAtMs: BASE + 3 * HOUR })]
    const summary = computeParallelismSummary(intervals, [], BASE, BASE + DAY)
    expect(summary.hasData).toBe(true)
    expect(summary.totalRunMs).toBe(3 * HOUR)
    expect(summary.peak?.count).toBe(1)
    expect(summary.screenTimeMs).toBe(0)
    // The ratio cannot be computed (nothing to divide by) — null, not Infinity/NaN.
    expect(summary.multiplier).toBeNull()
  })
})

describe('computeParallelismSummary — the multiplier formula (agent run time ÷ screen time)', () => {
  it('computes multiplier as totalRunMs / screenTimeMs for a clean ratio', () => {
    // 6 hours of agent run time, 2 hours of screen time -> 3x.
    const intervals = [iv({ startedAtMs: BASE, endedAtMs: BASE + 6 * HOUR })]
    const focusIntervals = [focus(BASE, BASE + 2 * HOUR)]
    const summary = computeParallelismSummary(intervals, focusIntervals, BASE, BASE + DAY)
    expect(summary.totalRunMs).toBe(6 * HOUR)
    expect(summary.screenTimeMs).toBe(2 * HOUR)
    expect(summary.multiplier).toBe(3)
  })

  it('is exactly 1 (not approximately) when screen time equals agent run time — dividing a sum by the identical value is exact in IEEE754', () => {
    const intervals = [iv({ startedAtMs: BASE, endedAtMs: BASE + 2 * HOUR })]
    const focusIntervals = [focus(BASE, BASE + 2 * HOUR)]
    const summary = computeParallelismSummary(intervals, focusIntervals, BASE, BASE + DAY)
    expect(summary.multiplier).toBe(1)
    expect(Object.is(summary.multiplier, 1)).toBe(true)
  })

  it('can exceed 10x by a lot when agents worked unattended (far more run time than screen time)', () => {
    // 20 hours of agent run time (several overlapping agents), only 1 hour of screen time.
    const intervals = [
      iv({ sessionId: 'a', startedAtMs: BASE, endedAtMs: BASE + 10 * HOUR }),
      iv({ sessionId: 'b', startedAtMs: BASE, endedAtMs: BASE + 10 * HOUR })
    ]
    const focusIntervals = [focus(BASE, BASE + HOUR)]
    const summary = computeParallelismSummary(intervals, focusIntervals, BASE, BASE + DAY)
    expect(summary.totalRunMs).toBe(20 * HOUR)
    expect(summary.screenTimeMs).toBe(HOUR)
    expect(summary.multiplier).toBe(20)
    expect(formatMultiplier(summary.multiplier!)).toBe('20')
  })

  it('unions overlapping screen-time intervals instead of summing them (no double-counting a heartbeat/close race)', () => {
    const intervals = [iv({ startedAtMs: BASE, endedAtMs: BASE + HOUR })]
    // Two overlapping focus rows spanning [0h,1h] and [0.5h,1.5h] together cover 1.5h, not 2h.
    const focusIntervals = [focus(BASE, BASE + HOUR), focus(BASE + 0.5 * HOUR, BASE + 1.5 * HOUR)]
    const summary = computeParallelismSummary(intervals, focusIntervals, BASE, BASE + DAY)
    expect(summary.screenTimeMs).toBe(1.5 * HOUR)
  })

  it('clips screen time at the start of the period', () => {
    const intervals = [iv({ startedAtMs: BASE, endedAtMs: BASE + HOUR })]
    const focusIntervals = [focus(BASE - HOUR, BASE + HOUR)]
    const summary = computeParallelismSummary(intervals, focusIntervals, BASE, BASE + DAY)
    expect(summary.screenTimeMs).toBe(HOUR)
  })

  it('clips screen time at the end of the period', () => {
    const intervals = [iv({ startedAtMs: BASE, endedAtMs: BASE + HOUR })]
    const focusIntervals = [focus(BASE + DAY - HOUR, BASE + DAY + HOUR)]
    const summary = computeParallelismSummary(intervals, focusIntervals, BASE, BASE + DAY)
    expect(summary.screenTimeMs).toBe(HOUR)
  })

  it('drops a screen-time interval entirely outside the period', () => {
    const intervals = [iv({ startedAtMs: BASE, endedAtMs: BASE + HOUR })]
    const focusIntervals = [focus(BASE - 2 * DAY, BASE - DAY)]
    const summary = computeParallelismSummary(intervals, focusIntervals, BASE, BASE + DAY)
    expect(summary.screenTimeMs).toBe(0)
    expect(summary.multiplier).toBeNull()
  })

  it('treats a still-open screen-time interval (endedAtMs null) as focused through periodEndMs', () => {
    const intervals = [iv({ startedAtMs: BASE, endedAtMs: BASE + HOUR })]
    const focusIntervals = [focus(BASE, null)]
    const summary = computeParallelismSummary(intervals, focusIntervals, BASE, BASE + HOUR)
    expect(summary.screenTimeMs).toBe(HOUR)
    expect(summary.multiplier).toBe(1)
  })
})

describe('computeParallelismSummary — peak/lanes/totalRunMs are unaffected by the screen-time change', () => {
  it('counts two fully overlapping intervals as totalRunMs 4h, wallMs (agent-union) 2h, peak 2', () => {
    const intervals = [
      iv({ sessionId: 'a', startedAtMs: BASE, endedAtMs: BASE + 2 * HOUR }),
      iv({ sessionId: 'b', startedAtMs: BASE, endedAtMs: BASE + 2 * HOUR })
    ]
    const summary = computeParallelismSummary(intervals, fullPeriodFocus(BASE, BASE + DAY), BASE, BASE + DAY)
    expect(summary.totalRunMs).toBe(4 * HOUR)
    expect(summary.wallMs).toBe(2 * HOUR)
    expect(summary.peak?.count).toBe(2)
    expect(summary.peak?.atMs).toBe(BASE)
  })

  it('handles a nested interval correctly (peak 2 only during the nested window)', () => {
    const intervals = [
      iv({ sessionId: 'outer', startedAtMs: BASE, endedAtMs: BASE + 10 * HOUR }),
      iv({ sessionId: 'inner', startedAtMs: BASE + 2 * HOUR, endedAtMs: BASE + 3 * HOUR })
    ]
    const summary = computeParallelismSummary(intervals, fullPeriodFocus(BASE, BASE + DAY), BASE, BASE + DAY)
    expect(summary.wallMs).toBe(10 * HOUR) // union = the outer span
    expect(summary.totalRunMs).toBe(11 * HOUR) // 10h + 1h
    expect(summary.peak?.count).toBe(2)
    expect(summary.peak?.atMs).toBe(BASE + 2 * HOUR)
  })

  it('does not count adjacent (touching, non-overlapping) intervals as concurrent', () => {
    const intervals = [
      iv({ sessionId: 'a', startedAtMs: BASE, endedAtMs: BASE + HOUR }),
      iv({ sessionId: 'b', startedAtMs: BASE + HOUR, endedAtMs: BASE + 2 * HOUR })
    ]
    const summary = computeParallelismSummary(intervals, fullPeriodFocus(BASE, BASE + DAY), BASE, BASE + DAY)
    expect(summary.peak?.count).toBe(1)
    expect(summary.wallMs).toBe(2 * HOUR)
    expect(summary.totalRunMs).toBe(2 * HOUR)
  })

  it('treats disjoint (gapped) intervals as separate wall segments', () => {
    const intervals = [
      iv({ sessionId: 'a', startedAtMs: BASE, endedAtMs: BASE + HOUR }),
      iv({ sessionId: 'b', startedAtMs: BASE + 3 * HOUR, endedAtMs: BASE + 4 * HOUR })
    ]
    const summary = computeParallelismSummary(intervals, fullPeriodFocus(BASE, BASE + DAY), BASE, BASE + DAY)
    expect(summary.wallMs).toBe(2 * HOUR)
    expect(summary.totalRunMs).toBe(2 * HOUR)
    expect(summary.peak?.count).toBe(1)
  })

  it('reports the FIRST timestamp the peak is reached, not a later repeat', () => {
    const intervals = [
      iv({ sessionId: 'a', startedAtMs: BASE, endedAtMs: BASE + HOUR }),
      iv({ sessionId: 'b', startedAtMs: BASE, endedAtMs: BASE + HOUR }),
      // Same peak (2) again later — should not move peak.atMs.
      iv({ sessionId: 'c', startedAtMs: BASE + 5 * HOUR, endedAtMs: BASE + 6 * HOUR }),
      iv({ sessionId: 'd', startedAtMs: BASE + 5 * HOUR, endedAtMs: BASE + 6 * HOUR })
    ]
    const summary = computeParallelismSummary(intervals, fullPeriodFocus(BASE, BASE + DAY), BASE, BASE + DAY)
    expect(summary.peak?.count).toBe(2)
    expect(summary.peak?.atMs).toBe(BASE)
  })

  it('treats a still-open agent interval (endedAtMs null) as running through periodEndMs', () => {
    const intervals = [iv({ startedAtMs: BASE, endedAtMs: null })]
    const summary = computeParallelismSummary(intervals, [focus(BASE, BASE + HOUR)], BASE, BASE + HOUR)
    expect(summary.totalRunMs).toBe(HOUR)
    expect(summary.wallMs).toBe(HOUR)
  })
})

describe('computeParallelismSummary — agent-run period clipping', () => {
  it('clips an interval that starts before the period', () => {
    const intervals = [iv({ startedAtMs: BASE - HOUR, endedAtMs: BASE + HOUR })]
    const summary = computeParallelismSummary(intervals, fullPeriodFocus(BASE, BASE + DAY), BASE, BASE + DAY)
    expect(summary.totalRunMs).toBe(HOUR)
  })

  it('clips an interval that ends after the period', () => {
    const intervals = [iv({ startedAtMs: BASE + DAY - HOUR, endedAtMs: BASE + DAY + HOUR })]
    const summary = computeParallelismSummary(intervals, fullPeriodFocus(BASE, BASE + DAY), BASE, BASE + DAY)
    expect(summary.totalRunMs).toBe(HOUR)
  })

  it('drops an interval entirely outside the period', () => {
    const intervals = [iv({ startedAtMs: BASE - 2 * DAY, endedAtMs: BASE - DAY })]
    const summary = computeParallelismSummary(intervals, fullPeriodFocus(BASE, BASE + DAY), BASE, BASE + DAY)
    expect(summary.hasData).toBe(false)
  })

  it('drops an interval that only touches the period boundary (zero-length after clipping)', () => {
    const intervals = [iv({ startedAtMs: BASE - HOUR, endedAtMs: BASE })]
    const summary = computeParallelismSummary(intervals, fullPeriodFocus(BASE, BASE + DAY), BASE, BASE + DAY)
    expect(summary.hasData).toBe(false)
  })
})

describe('computeParallelismSummary — peak day and lanes (unaffected by the screen-time change)', () => {
  it('identifies the correct calendar day for the peak and builds lanes for it', () => {
    const day0 = BASE
    const day1 = BASE + DAY
    const intervals = [
      // Day 0: just one agent.
      iv({ sessionId: 'solo', startedAtMs: day0 + HOUR, endedAtMs: day0 + 2 * HOUR }),
      // Day 1: three overlapping agents — this is the peak day.
      iv({ sessionId: 'x', startedAtMs: day1 + HOUR, endedAtMs: day1 + 5 * HOUR }),
      iv({ sessionId: 'y', startedAtMs: day1 + 2 * HOUR, endedAtMs: day1 + 4 * HOUR }),
      iv({ sessionId: 'z', startedAtMs: day1 + 3 * HOUR, endedAtMs: day1 + 6 * HOUR })
    ]
    const summary = computeParallelismSummary(intervals, fullPeriodFocus(BASE, BASE + 2 * DAY), BASE, BASE + 2 * DAY)
    expect(summary.peak?.count).toBe(3)
    expect(summary.peak?.day).toBe('2026-01-02')

    // Window is [day1+1h, day1+6h] -> span 5h.
    expect(summary.peakDayLanes).toHaveLength(3)
    const laneX = summary.peakDayLanes.find((l) => l.sessionId === 'x')!
    expect(laneX.segments).toHaveLength(1)
    expect(laneX.segments[0].startFrac).toBeCloseTo(0, 5)
    expect(laneX.segments[0].endFrac).toBeCloseTo(4 / 5, 5)

    const laneZ = summary.peakDayLanes.find((l) => l.sessionId === 'z')!
    expect(laneZ.segments[0].startFrac).toBeCloseTo(2 / 5, 5)
    expect(laneZ.segments[0].endFrac).toBeCloseTo(1, 5)
  })

  it('gives a session multiple segments when it has more than one run that day', () => {
    const intervals = [
      iv({ sessionId: 'a', startedAtMs: BASE + HOUR, endedAtMs: BASE + 2 * HOUR }),
      iv({ sessionId: 'a', startedAtMs: BASE + 4 * HOUR, endedAtMs: BASE + 5 * HOUR }),
      iv({ sessionId: 'b', startedAtMs: BASE + 2.5 * HOUR, endedAtMs: BASE + 3 * HOUR })
    ]
    const summary = computeParallelismSummary(intervals, fullPeriodFocus(BASE, BASE + DAY), BASE, BASE + DAY)
    const laneA = summary.peakDayLanes.find((l) => l.sessionId === 'a')!
    expect(laneA.segments).toHaveLength(2)
  })
})

describe('computeParallelismSummary — per-day run hours (unaffected by the screen-time change)', () => {
  it('produces one row per calendar day in the period, including zero-activity days', () => {
    const intervals = [iv({ startedAtMs: BASE + HOUR, endedAtMs: BASE + 3 * HOUR })]
    const summary = computeParallelismSummary(intervals, fullPeriodFocus(BASE, BASE + 3 * DAY), BASE, BASE + 3 * DAY)
    expect(summary.perDay).toHaveLength(3)
    expect(summary.perDay[0].runHours).toBeCloseTo(2, 5)
    expect(summary.perDay[1].runHours).toBe(0)
    expect(summary.perDay[2].runHours).toBe(0)
  })

  it('splits a run that spans midnight across both days', () => {
    const intervals = [iv({ startedAtMs: BASE + 22 * HOUR, endedAtMs: BASE + DAY + 2 * HOUR })]
    const summary = computeParallelismSummary(intervals, fullPeriodFocus(BASE, BASE + 2 * DAY), BASE, BASE + 2 * DAY)
    expect(summary.perDay[0].runHours).toBeCloseTo(2, 5)
    expect(summary.perDay[1].runHours).toBeCloseTo(2, 5)
  })

  it('honors a non-zero utcOffsetMinutes for day bucketing', () => {
    // 23:00 UTC on day0 is 02:00 local the next day at UTC+3.
    const intervals = [iv({ startedAtMs: BASE + 23 * HOUR, endedAtMs: BASE + 23 * HOUR + 30 * 60_000 })]
    const offsetMinutes = 3 * 60
    const summaryUtc = computeParallelismSummary(intervals, fullPeriodFocus(BASE, BASE + DAY), BASE, BASE + DAY, 0)
    const summaryOffset = computeParallelismSummary(intervals, fullPeriodFocus(BASE, BASE + DAY), BASE, BASE + DAY, offsetMinutes)
    expect(summaryUtc.perDay[0].runHours).toBeCloseTo(0.5, 5)
    // Under the offset, that half hour falls on the *next* local day — the
    // first day row (still UTC day 0) should show no activity instead.
    expect(summaryOffset.perDay[0].runHours).toBe(0)
  })
})

describe('formatMultiplier', () => {
  it('shows one decimal below 10', () => {
    expect(formatMultiplier(3.44)).toBe('3.4')
    expect(formatMultiplier(1)).toBe('1.0')
  })

  it('shows a rounded integer at 10 and above, including large "unattended agents" multipliers', () => {
    expect(formatMultiplier(10)).toBe('10')
    expect(formatMultiplier(14.6)).toBe('15')
    expect(formatMultiplier(137)).toBe('137')
  })
})

describe('periodBoundsForDays', () => {
  it('resolves explicit bounds without reading the current date', () => {
    const { periodStartMs, periodEndMs } = periodBoundsForDays(30, BASE)
    expect(periodEndMs).toBe(BASE)
    expect(periodStartMs).toBe(BASE - 30 * DAY)
  })
})

describe('computeParallelismSummary — perf', () => {
  it('stays well within budget for tens of thousands of intervals', () => {
    const intervals: RawAgentRunInterval[] = []
    const periodStart = BASE
    const periodEnd = BASE + 182 * DAY
    for (let i = 0; i < 50_000; i++) {
      const start = periodStart + (i * 97) % (182 * DAY)
      intervals.push(iv({ sessionId: `s-${i}`, startedAtMs: start, endedAtMs: start + 15 * 60_000 }))
    }
    const focusIntervals = fullPeriodFocus(periodStart, periodEnd)

    const startedAt = Date.now()
    const summary = computeParallelismSummary(intervals, focusIntervals, periodStart, periodEnd)
    const elapsedMs = Date.now() - startedAt

    expect(summary.hasData).toBe(true)
    expect(elapsedMs).toBeLessThan(2000)
  })
})
