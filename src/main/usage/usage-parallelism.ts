/**
 * The "my multiplier" query engine: how much agent work got done per hour
 * the user actually spent with 20x on screen.
 *
 *   multiplier = (total agent run time across all concurrent agents)
 *              ÷ (the user's own screen time in the app)
 *
 * This deliberately rewards agents working while the user wasn't looking —
 * that is the point of the metric. (An earlier version of this comment, and
 * of the formula, used the wall-clock time with ≥1 agent running as the
 * denominator — i.e. "vs. one agent working alone". That undercounted the
 * exact scenario this metric exists to surface, so the denominator is now
 * the user's screen time, tracked by src/main/usage/app-focus-intervals.ts.)
 *
 * The peak (max simultaneous agents + which day + that day's lanes) and the
 * per-day agent-run hours are unaffected by this — they come entirely from
 * the agent-run sweep, independent of screen time.
 *
 * Pure functions only — no Date.now(), no DB access. Callers (agent-manager.ts,
 * the mobile API) resolve `agent_run_intervals`/`app_focus_intervals` rows via
 * database.ts and pass explicit period bounds, which keeps this module
 * trivially unit-testable and safe to run against large synthetic fixtures
 * (perf tests).
 *
 * "Running" means the session was in a working/busy state — waiting-for-
 * approval, idle, errored and stopped time does not count. That distinction
 * is already baked into which rows exist: src/main/usage/agent-run-intervals.ts
 * only ever opens a row while a session is 'working'.
 */

// Types are defined in shared/usage.ts (not here) so the renderer, mobile,
// and preload bridge can reference them without reaching into src/main — see
// the "my multiplier" wire types section there. Re-exported here for this
// module's own internal use and for existing call sites that import them
// from this file.
export {
  formatMultiplier,
  type RawAgentRunInterval,
  type RawAppFocusInterval,
  type ParallelismPeak,
  type ParallelismLaneSegment,
  type ParallelismLane,
  type ParallelismDayRow,
  type ParallelismSummary,
  type ParallelismPeriodDays,
  type UsageParallelismResponse
} from '../../shared/usage'
import type {
  RawAgentRunInterval,
  RawAppFocusInterval,
  ParallelismPeak,
  ParallelismLane,
  ParallelismDayRow,
  ParallelismSummary,
  ParallelismPeriodDays
} from '../../shared/usage'

/** An interval clipped to the query period, guaranteed `start < end`. */
interface ClippedInterval {
  sessionId: string
  taskId: string
  agentId: string
  provider: string
  harnessInstanceId: string | null
  start: number
  end: number
}

const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_DAY = 24 * MS_PER_HOUR

/** `YYYY-MM-DD` for `ms`, shifted by `utcOffsetMinutes` east of UTC before formatting. */
function dayKeyFor(ms: number, utcOffsetMinutes: number): string {
  const shifted = new Date(ms + utcOffsetMinutes * 60_000)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Start-of-local-day (in the given offset) boundary, as a UTC ms timestamp, for whichever local day `ms` falls in. */
function localDayStartMs(ms: number, utcOffsetMinutes: number): number {
  const shifted = ms + utcOffsetMinutes * 60_000
  const flooredShifted = Math.floor(shifted / MS_PER_DAY) * MS_PER_DAY
  return flooredShifted - utcOffsetMinutes * 60_000
}

function clipIntervals(raw: RawAgentRunInterval[], periodStartMs: number, periodEndMs: number): ClippedInterval[] {
  const out: ClippedInterval[] = []
  for (const r of raw) {
    const end = r.endedAtMs ?? periodEndMs
    const start = Math.max(r.startedAtMs, periodStartMs)
    const clippedEnd = Math.min(end, periodEndMs)
    if (clippedEnd <= start) continue
    out.push({
      sessionId: r.sessionId,
      taskId: r.taskId,
      agentId: r.agentId,
      provider: r.provider,
      harnessInstanceId: r.harnessInstanceId,
      start,
      end: clippedEnd
    })
  }
  return out
}

/** Clips app-focus intervals to the period — same rule as `clipIntervals`, without the agent-run identity fields it doesn't have. */
function clipFocusIntervals(raw: RawAppFocusInterval[], periodStartMs: number, periodEndMs: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  for (const r of raw) {
    const end = r.endedAtMs ?? periodEndMs
    const start = Math.max(r.startedAtMs, periodStartMs)
    const clippedEnd = Math.min(end, periodEndMs)
    if (clippedEnd <= start) continue
    out.push({ start, end: clippedEnd })
  }
  return out
}

/**
 * Sweep-line over start/end events. Returns total run ms (sum of durations),
 * union ms (wall time with ≥1 active), and the peak (count + first ms it was
 * reached). O(n log n) — fine up to tens of thousands of intervals (see the
 * perf test in usage-parallelism.test.ts).
 *
 * Ties are broken by processing ends before starts at the same timestamp, so
 * a session ending exactly when another begins is adjacent, not overlapping
 * — it must not spike the concurrency count.
 */
function sweep(intervals: Array<{ start: number; end: number }>): { totalRunMs: number; wallMs: number; peak: { count: number; atMs: number } | null } {
  let totalRunMs = 0
  for (const iv of intervals) totalRunMs += iv.end - iv.start
  if (intervals.length === 0) return { totalRunMs: 0, wallMs: 0, peak: null }

  type Event = { t: number; delta: 1 | -1 }
  const events: Event[] = []
  for (const iv of intervals) {
    events.push({ t: iv.start, delta: 1 })
    events.push({ t: iv.end, delta: -1 })
  }
  // Ends (-1) before starts (+1) at the same instant.
  events.sort((a, b) => (a.t - b.t) || (a.delta - b.delta))

  let wallMs = 0
  let concurrency = 0
  let peakCount = 0
  let peakAtMs = events[0].t
  let prevT = events[0].t

  let i = 0
  while (i < events.length) {
    const t = events[i].t
    if (concurrency > 0) wallMs += t - prevT
    // Apply every event at this exact timestamp before checking the peak.
    while (i < events.length && events[i].t === t) {
      concurrency += events[i].delta
      i++
    }
    if (concurrency > peakCount) {
      peakCount = concurrency
      peakAtMs = t
    }
    prevT = t
  }

  return { totalRunMs, wallMs, peak: peakCount > 0 ? { count: peakCount, atMs: peakAtMs } : null }
}

/** Builds the lane chart for the peak day: every session with an interval overlapping that day, clipped and normalized to the day's active window (first interval start to last interval end that day). */
function buildPeakDayLanes(intervals: ClippedInterval[], dayStartMs: number, dayEndMs: number): ParallelismLane[] {
  const dayClipped = intervals
    .map((iv) => ({ ...iv, start: Math.max(iv.start, dayStartMs), end: Math.min(iv.end, dayEndMs) }))
    .filter((iv) => iv.end > iv.start)

  if (dayClipped.length === 0) return []

  const windowStart = Math.min(...dayClipped.map((iv) => iv.start))
  const windowEnd = Math.max(...dayClipped.map((iv) => iv.end))
  const windowSpan = windowEnd - windowStart
  if (windowSpan <= 0) return []

  const bySession = new Map<string, ParallelismLane>()
  for (const iv of dayClipped) {
    let lane = bySession.get(iv.sessionId)
    if (!lane) {
      lane = {
        sessionId: iv.sessionId,
        taskId: iv.taskId,
        agentId: iv.agentId,
        provider: iv.provider,
        harnessInstanceId: iv.harnessInstanceId,
        segments: []
      }
      bySession.set(iv.sessionId, lane)
    }
    lane.segments.push({
      startFrac: (iv.start - windowStart) / windowSpan,
      endFrac: (iv.end - windowStart) / windowSpan
    })
  }

  return [...bySession.values()]
}

/** Per-calendar-day run/wall hours, one row per day in `[periodStartMs, periodEndMs)` regardless of activity. */
function buildPerDay(intervals: ClippedInterval[], periodStartMs: number, periodEndMs: number, utcOffsetMinutes: number): ParallelismDayRow[] {
  const days: ParallelismDayRow[] = []
  let dayStart = localDayStartMs(periodStartMs, utcOffsetMinutes)
  while (dayStart < periodEndMs) {
    const dayEnd = dayStart + MS_PER_DAY
    const rangeStart = Math.max(dayStart, periodStartMs)
    const rangeEnd = Math.min(dayEnd, periodEndMs)

    const dayIntervals = intervals
      .map((iv) => ({ start: Math.max(iv.start, rangeStart), end: Math.min(iv.end, rangeEnd) }))
      .filter((iv) => iv.end > iv.start)

    const runMs = dayIntervals.reduce((sum, iv) => sum + (iv.end - iv.start), 0)
    const { wallMs } = sweep(dayIntervals)

    days.push({
      day: dayKeyFor(rangeStart, utcOffsetMinutes),
      runHours: runMs / MS_PER_HOUR,
      wallHours: wallMs / MS_PER_HOUR
    })
    dayStart = dayEnd
  }
  return days
}

/**
 * Computes the full parallelism summary for `[periodStartMs, periodEndMs)`.
 * `utcOffsetMinutes` (minutes east of UTC) controls calendar-day bucketing
 * for `perDay` and the peak day's lanes; defaults to UTC.
 *
 * `rawFocusIntervals` (`app_focus_intervals` rows) supplies the multiplier's
 * denominator — the user's own screen time in the app. It is independent of
 * `rawIntervals` (agent-run intervals, which still drive everything else:
 * totalRunMs, peak, peakDayLanes, perDay).
 */
export function computeParallelismSummary(
  rawIntervals: RawAgentRunInterval[],
  rawFocusIntervals: RawAppFocusInterval[],
  periodStartMs: number,
  periodEndMs: number,
  utcOffsetMinutes = 0
): ParallelismSummary {
  const clipped = clipIntervals(rawIntervals, periodStartMs, periodEndMs)
  const perDay = buildPerDay(clipped, periodStartMs, periodEndMs, utcOffsetMinutes)

  // Union (not sum) of focus intervals — overlapping rows (e.g. a heartbeat
  // touch racing a close, or more than one window) must not double-count
  // screen time. `sweep`'s wallMs is exactly this union.
  const clippedFocus = clipFocusIntervals(rawFocusIntervals, periodStartMs, periodEndMs)
  const { wallMs: screenTimeMs } = sweep(clippedFocus)

  if (clipped.length === 0) {
    return {
      periodStartMs,
      periodEndMs,
      hasData: false,
      totalRunMs: 0,
      wallMs: 0,
      screenTimeMs,
      multiplier: null,
      peak: null,
      peakDayLanes: [],
      perDay
    }
  }

  const { totalRunMs, wallMs, peak: rawPeak } = sweep(clipped)
  // Null (not Infinity/NaN) when there's no screen time to divide by — e.g.
  // all the agent work happened before focus tracking existed, or entirely
  // unattended. This is deliberately NOT clamped or special-cased for a
  // single agent: the real ratio of run time to screen time is the point.
  const multiplier = screenTimeMs > 0 ? totalRunMs / screenTimeMs : null

  let peak: ParallelismPeak | null = null
  let peakDayLanes: ParallelismLane[] = []
  if (rawPeak) {
    const day = dayKeyFor(rawPeak.atMs, utcOffsetMinutes)
    peak = { count: rawPeak.count, atMs: rawPeak.atMs, day }
    const dayStartMs = localDayStartMs(rawPeak.atMs, utcOffsetMinutes)
    const dayEndMs = dayStartMs + MS_PER_DAY
    peakDayLanes = buildPeakDayLanes(clipped, dayStartMs, dayEndMs)
  }

  return {
    periodStartMs,
    periodEndMs,
    hasData: true,
    totalRunMs,
    wallMs,
    screenTimeMs,
    multiplier,
    peak,
    peakDayLanes,
    perDay
  }
}

/**
 * Resolves a period choice (7/30/90/182 days) to explicit `[start, end)`
 * bounds ending at `endMs`. Kept out of `computeParallelismSummary` itself so
 * the engine never reaches for `Date.now()` — callers (agent-manager.ts, the
 * mobile API route) pass `endMs` explicitly, and tests pass a fixed value.
 */
export function periodBoundsForDays(days: ParallelismPeriodDays, endMs: number): { periodStartMs: number; periodEndMs: number } {
  return { periodStartMs: endMs - days * MS_PER_DAY, periodEndMs: endMs }
}
