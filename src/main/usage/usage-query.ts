import type { UsageSummaryQuery } from '../../shared/usage'
import type { ParallelismPeriodDays } from './usage-parallelism'

const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000
const MAX_UTC_OFFSET_MINUTES = 14 * 60
const PARALLELISM_PERIOD_DAYS: readonly ParallelismPeriodDays[] = [7, 30, 90, 182]

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Validates a usage summary query coming from the renderer (IPC) or a mobile
 * client (query string). Unknown/invalid fields are dropped; the range is
 * clamped to at most one year.
 */
export function sanitizeUsageSummaryQuery(raw: unknown): UsageSummaryQuery {
  if (!raw || typeof raw !== 'object') return {}
  const input = raw as Record<string, unknown>
  const query: UsageSummaryQuery = {}

  const untilMs = finiteNumber(input.untilMs)
  if (untilMs !== undefined && untilMs > 0) query.untilMs = Math.floor(untilMs)

  const sinceMs = finiteNumber(input.sinceMs)
  if (sinceMs !== undefined && sinceMs >= 0) {
    const upper = query.untilMs ?? Date.now()
    query.sinceMs = Math.max(Math.floor(sinceMs), upper - MAX_RANGE_MS)
  }

  const offset = finiteNumber(input.utcOffsetMinutes)
  if (offset !== undefined && Math.abs(offset) <= MAX_UTC_OFFSET_MINUTES) {
    query.utcOffsetMinutes = Math.round(offset)
  }

  if (typeof input.taskId === 'string' && input.taskId.trim()) query.taskId = input.taskId.trim()
  return query
}

export interface UsageParallelismQuery {
  /** One of 7/30/90/182. Defaults to 30 when missing or not one of those values. */
  days: ParallelismPeriodDays
  /** Minutes east of UTC for calendar-day bucketing. Defaults to the main process' local offset when absent. */
  utcOffsetMinutes?: number
}

/**
 * Validates a "my multiplier" period query coming from the renderer (IPC) or
 * a mobile client (query string). Unlike `sanitizeUsageSummaryQuery`, the
 * window is always one of the four fixed card periods, not an arbitrary
 * range — `days` is clamped to that set rather than passed through.
 */
export function sanitizeUsageParallelismQuery(raw: unknown): UsageParallelismQuery {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const parsedDays = finiteNumber(input.days)
  const days = (parsedDays !== undefined && (PARALLELISM_PERIOD_DAYS as readonly number[]).includes(parsedDays))
    ? (parsedDays as ParallelismPeriodDays)
    : 30

  const query: UsageParallelismQuery = { days }
  const offset = finiteNumber(input.utcOffsetMinutes)
  if (offset !== undefined && Math.abs(offset) <= MAX_UTC_OFFSET_MINUTES) {
    query.utcOffsetMinutes = Math.round(offset)
  }
  return query
}
