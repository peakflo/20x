/**
 * The "my multiplier" query engine: how many agents worked in parallel on
 * average over a period, vs. one agent working alone.
 *
 *   multiplier = (total agent run time across all concurrent agents)
 *              ÷ (wall-clock time during which ≥1 agent was running)
 *
 * One agent running alone for its whole life is exactly 1×. The peak is a
 * separate, smaller fact: the maximum number of agents running at the same
 * instant in the period.
 *
 * Pure functions only — no Date.now(), no DB access. Callers (agent-manager.ts,
 * the mobile API) resolve `agent_run_intervals` rows via database.ts and pass
 * explicit period bounds, which keeps this module trivially unit-testable and
 * safe to run against large synthetic fixtures (perf tests).
 *
 * "Running" means the session was in a working/busy state — waiting-for-
 * approval, idle, errored and stopped time does not count. That distinction
 * is already baked into which rows exist: src/main/usage/agent-run-intervals.ts
 * only ever opens a row while a session is 'working'.
 */

/** One `agent_run_intervals` row, as read from the database (possibly still open). */
export interface RawAgentRunInterval {
  sessionId: string
  taskId: string
  agentId: string
  provider: string
  harnessInstanceId: string | null
  startedAtMs: number
  /** Null means the session is still working as of the query — treated as running through `periodEndMs`. */
  endedAtMs: number | null
}

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

export interface ParallelismPeak {
  /** Max number of sessions running at the same instant. */
  count: number
  /** First timestamp (ms) at which that max was reached. */
  atMs: number
  /** Calendar day `atMs` falls on, as `YYYY-MM-DD` in the query's chosen offset. */
  day: string
}

/** One run segment on the peak day's lane chart, normalized to 0..1 across that day's active window. */
export interface ParallelismLaneSegment {
  startFrac: number
  endFrac: number
}

/** All of one session's segments on the peak day — the `laneRuns`-equivalent for phase 2's UI. */
export interface ParallelismLane {
  sessionId: string
  taskId: string
  agentId: string
  provider: string
  harnessInstanceId: string | null
  segments: ParallelismLaneSegment[]
}

export interface ParallelismDayRow {
  /** `YYYY-MM-DD` in the query's chosen offset. */
  day: string
  /** Sum of run time that calendar day, in hours (agent-hours — this is the numerator, not wall time). */
  runHours: number
  /** Wall-clock hours that day with ≥1 agent running. */
  wallHours: number
}

export interface ParallelismSummary {
  periodStartMs: number
  periodEndMs: number
  /** False when there is no interval overlapping the period at all — the UI should show "no data", not 0 or NaN. */
  hasData: boolean
  /** Sum of every (clipped) interval's duration, in ms. The multiplier's numerator. */
  totalRunMs: number
  /** Union of all (clipped) intervals, in ms — wall-clock time with ≥1 agent running. The multiplier's denominator. */
  wallMs: number
  /**
   * `totalRunMs / wallMs`. Null when `hasData` is false (never NaN). Exactly
   * `1` — not approximately — when only one agent ever ran, with no gaps of
   * zero-agent time inside its own span: dividing a sum by the identical
   * value it was computed from is exact in IEEE754, so no epsilon handling
   * is needed here.
   */
  multiplier: number | null
  /** Null when `hasData` is false. */
  peak: ParallelismPeak | null
  /** Lanes for the peak day, empty when `hasData` is false. */
  peakDayLanes: ParallelismLane[]
  /** One row per calendar day in `[periodStartMs, periodEndMs)`, even when a day has no activity (keeps chart alignment). */
  perDay: ParallelismDayRow[]
}

const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_DAY = 24 * MS_PER_HOUR

/** Formats the multiplier per the UI rule: an integer at 10×+, one decimal below that. Pure string formatting — kept separate from the numeric `multiplier` field so callers can still do their own math with the raw number. */
export function formatMultiplier(raw: number): string {
  if (!Number.isFinite(raw)) return '—'
  if (raw >= 10) return String(Math.round(raw))
  return raw.toFixed(1)
}

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
 */
export function computeParallelismSummary(
  rawIntervals: RawAgentRunInterval[],
  periodStartMs: number,
  periodEndMs: number,
  utcOffsetMinutes = 0
): ParallelismSummary {
  const clipped = clipIntervals(rawIntervals, periodStartMs, periodEndMs)
  const perDay = buildPerDay(clipped, periodStartMs, periodEndMs, utcOffsetMinutes)

  if (clipped.length === 0) {
    return {
      periodStartMs,
      periodEndMs,
      hasData: false,
      totalRunMs: 0,
      wallMs: 0,
      multiplier: null,
      peak: null,
      peakDayLanes: [],
      perDay
    }
  }

  const { totalRunMs, wallMs, peak: rawPeak } = sweep(clipped)
  // wallMs > 0 whenever clipped.length > 0 (every clipped interval has positive duration).
  const multiplier = wallMs > 0 ? totalRunMs / wallMs : null

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
    multiplier,
    peak,
    peakDayLanes,
    perDay
  }
}

/** Supported "my multiplier" card periods. */
export type ParallelismPeriodDays = 7 | 30 | 90 | 182

/**
 * Resolves a period choice (7/30/90/182 days) to explicit `[start, end)`
 * bounds ending at `endMs`. Kept out of `computeParallelismSummary` itself so
 * the engine never reaches for `Date.now()` — callers (agent-manager.ts, the
 * mobile API route) pass `endMs` explicitly, and tests pass a fixed value.
 */
export function periodBoundsForDays(days: ParallelismPeriodDays, endMs: number): { periodStartMs: number; periodEndMs: number } {
  return { periodStartMs: endMs - days * MS_PER_DAY, periodEndMs: endMs }
}

/**
 * The full "my multiplier" card payload for one period: the parallelism
 * summary plus the two figures that come from elsewhere in the codebase
 * (tasks shipped, token/cost totals) rather than from `agent_run_intervals`.
 * Composed by AgentManager.getUsageParallelismSummary — this module itself
 * stays DB-agnostic.
 */
export interface UsageParallelismResponse {
  periodDays: ParallelismPeriodDays
  periodStartMs: number
  periodEndMs: number
  parallelism: ParallelismSummary
  /** Tasks that reached `completed` within the period — see `DatabaseManager.getTasksShippedCount`. */
  tasksShipped: number
  /** Earliest `agent_run_intervals` row on record (live or backfilled), or null if there are none yet. Phase 2's "counting from <date>" hint. */
  countingFromMs: number | null
}
