/**
 * Opt-in main-thread profiler for the Electron main process.
 *
 * Enabled ONLY when `TWENTYX_PERF=1`. When disabled every export is a no-op
 * (the database handle is returned untouched), so normal runs pay nothing.
 *
 * What it records:
 * - Event-loop delay (perf_hooks.monitorEventLoopDelay): p50/p95/p99/max.
 * - Every better-sqlite3 call made on the main thread (prepare, run, get,
 *   all, iterate, exec, pragma, transaction): count, total ms, max ms, calls
 *   over 16 ms and 50 ms, and the slowest statements.
 *
 * A transaction body's own statements are recorded per statement, but only the
 * outermost call adds to `blockedMs`, so nested work is not counted twice.
 *
 * Usage: `TWENTYX_PERF=1 pnpm dev`. A report is logged every
 * `TWENTYX_PERF_INTERVAL_MS` (default 60 s) and on quit, and any single DB call
 * over `TWENTYX_PERF_SLOW_MS` (default 50 ms) is logged when it happens.
 */
import { monitorEventLoopDelay, performance, type IntervalHistogram } from 'node:perf_hooks'
import type Database from 'better-sqlite3'

export function isMainThreadPerfEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TWENTYX_PERF === '1'
}

export interface StatementStats {
  sql: string
  op: string
  count: number
  totalMs: number
  maxMs: number
}

export interface DbPerfSnapshot {
  /** Calls at the outermost level (a transaction counts once). */
  calls: number
  /** Main-thread ms spent inside better-sqlite3, outermost calls only. */
  blockedMs: number
  maxMs: number
  over16ms: number
  over50ms: number
  /** Slowest statements by max single-call duration. */
  slowest: StatementStats[]
  /** Statements by total time. */
  heaviest: StatementStats[]
}

export interface EventLoopSnapshot {
  p50: number
  p95: number
  p99: number
  max: number
  mean: number
  /** Samples recorded (one per resolution tick). */
  count: number
}

const MAX_SQL_LABEL = 160

function label(sql: string): string {
  const compact = sql.replace(/\s+/g, ' ').trim()
  return compact.length > MAX_SQL_LABEL ? compact.slice(0, MAX_SQL_LABEL) + '…' : compact
}

/** Aggregates timings for one database connection. Exported for tests and benchmarks. */
export class DbCallRecorder {
  private stats = new Map<string, StatementStats>()
  private depth = 0
  private calls = 0
  private blockedMs = 0
  private maxMs = 0
  private over16 = 0
  private over50 = 0

  constructor(private readonly onSlowCall?: (entry: { op: string; sql: string; ms: number }) => void) {}

  time<T>(op: string, sql: string, fn: () => T): T {
    const outer = this.depth === 0
    this.depth++
    const start = performance.now()
    try {
      return fn()
    } finally {
      const ms = performance.now() - start
      this.depth--
      this.record(op, sql, ms, outer)
    }
  }

  private record(op: string, sql: string, ms: number, outer: boolean): void {
    const key = `${op} ${sql}`
    let entry = this.stats.get(key)
    if (!entry) {
      entry = { sql, op, count: 0, totalMs: 0, maxMs: 0 }
      this.stats.set(key, entry)
    }
    entry.count++
    entry.totalMs += ms
    if (ms > entry.maxMs) entry.maxMs = ms
    if (!outer) return
    this.calls++
    this.blockedMs += ms
    if (ms > this.maxMs) this.maxMs = ms
    if (ms > 16) this.over16++
    if (ms > 50) {
      this.over50++
      this.onSlowCall?.({ op, sql, ms })
    }
  }

  snapshot(top = 10): DbPerfSnapshot {
    const all = [...this.stats.values()].map((s) => ({ ...s }))
    return {
      calls: this.calls,
      blockedMs: this.blockedMs,
      maxMs: this.maxMs,
      over16ms: this.over16,
      over50ms: this.over50,
      slowest: [...all].sort((a, b) => b.maxMs - a.maxMs).slice(0, top),
      heaviest: [...all].sort((a, b) => b.totalMs - a.totalMs).slice(0, top)
    }
  }

  reset(): void {
    this.stats.clear()
    this.calls = 0
    this.blockedMs = 0
    this.maxMs = 0
    this.over16 = 0
    this.over50 = 0
  }
}

const STATEMENT_EXEC = new Set(['run', 'get', 'all'])

function wrapStatement(stmt: Database.Statement, sql: string, recorder: DbCallRecorder): Database.Statement {
  const proxy: Database.Statement = new Proxy(stmt, {
    get(target, key) {
      const value = Reflect.get(target, key, target)
      if (typeof value !== 'function') return value
      if (STATEMENT_EXEC.has(key as string)) {
        return (...args: unknown[]) => recorder.time(key as string, sql, () => value.apply(target, args))
      }
      if (key === 'iterate') {
        return (...args: unknown[]) => {
          const it = recorder.time('iterate', sql, () => value.apply(target, args)) as IterableIterator<unknown>
          const timed: IterableIterator<unknown> = {
            next: (...a: []) => recorder.time('iterate', sql, () => it.next(...a)),
            return: (v?: unknown) => (it.return ? it.return(v) : { done: true, value: v }),
            [Symbol.iterator]() { return timed }
          }
          return timed
        }
      }
      // pluck/raw/expand/safeIntegers/bind return the statement itself: keep chaining on the proxy.
      return (...args: unknown[]) => {
        const result = value.apply(target, args)
        return result === target ? proxy : result
      }
    }
  })
  return proxy
}

/**
 * Wraps a better-sqlite3 connection so every call is timed by `recorder`.
 * The returned object is a Proxy over the same native handle.
 */
export function instrumentDatabase(db: Database.Database, recorder: DbCallRecorder): Database.Database {
  const proxy: Database.Database = new Proxy(db, {
    get(target, key) {
      const value = Reflect.get(target, key, target)
      if (typeof value !== 'function') return value
      switch (key) {
        case 'prepare':
          return (sql: string) => {
            const text = label(sql)
            const stmt = recorder.time('prepare', text, () => value.call(target, sql)) as Database.Statement
            return wrapStatement(stmt, text, recorder)
          }
        case 'exec':
          return (sql: string) => {
            recorder.time('exec', label(sql), () => value.call(target, sql))
            return proxy
          }
        case 'pragma':
          return (...args: unknown[]) => recorder.time('pragma', label(String(args[0])), () => value.apply(target, args))
        case 'transaction':
          return (fn: (...a: unknown[]) => unknown) => {
            const txn = value.call(target, fn) as Database.Transaction<(...a: unknown[]) => unknown>
            const sqlLabel = `transaction ${fn.name || '<anonymous>'}`
            const wrapped = ((...a: unknown[]) => recorder.time('transaction', sqlLabel, () => txn(...a))) as typeof txn
            for (const mode of ['deferred', 'immediate', 'exclusive'] as const) {
              const variant = txn[mode]
              wrapped[mode] = ((...a: unknown[]) => recorder.time('transaction', `${sqlLabel} (${mode})`, () => variant(...a))) as typeof variant
            }
            return wrapped
          }
        default:
          return value.bind(target)
      }
    }
  })
  return proxy
}

let recorder: DbCallRecorder | null = null
let histogram: IntervalHistogram | null = null
let reportTimer: NodeJS.Timeout | null = null

function ms(ns: number): number {
  return Number.isFinite(ns) ? ns / 1e6 : 0
}

/** Sampling interval of the event-loop delay histogram. */
export const EVENT_LOOP_RESOLUTION_MS = 10

/**
 * Event-loop delay percentiles. The histogram records the time between timer
 * ticks, which includes the sampling interval itself; it is subtracted so the
 * values are the extra delay (0 on an idle loop).
 */
export function eventLoopSnapshot(h: IntervalHistogram, resolutionMs = EVENT_LOOP_RESOLUTION_MS): EventLoopSnapshot {
  const delay = (ns: number): number => Math.max(0, ms(ns) - resolutionMs)
  return {
    p50: delay(h.percentile(50)),
    p95: delay(h.percentile(95)),
    p99: delay(h.percentile(99)),
    max: delay(h.max),
    mean: delay(h.mean),
    count: h.count
  }
}

/**
 * Returns `db` wrapped with timing when `TWENTYX_PERF=1`, otherwise `db` itself.
 * Called once when the main connection is opened.
 */
export function instrumentMainDatabase(db: Database.Database, env: NodeJS.ProcessEnv = process.env): Database.Database {
  if (!isMainThreadPerfEnabled(env)) return db
  const slowMs = Number(env.TWENTYX_PERF_SLOW_MS) || 50
  recorder ??= new DbCallRecorder(({ op, sql, ms: took }) => {
    if (took >= slowMs) console.warn(`[perf] slow main-thread DB ${op} ${took.toFixed(1)} ms: ${sql}`)
  })
  return instrumentDatabase(db, recorder)
}

/** Starts event-loop delay sampling and periodic reports when `TWENTYX_PERF=1`. */
export function startMainThreadPerf(env: NodeJS.ProcessEnv = process.env): void {
  if (!isMainThreadPerfEnabled(env) || histogram) return
  histogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS })
  histogram.enable()
  const interval = Number(env.TWENTYX_PERF_INTERVAL_MS) || 60_000
  reportTimer = setInterval(() => logMainThreadPerfReport('interval', true), interval)
  reportTimer.unref?.()
}

/** The recorder behind the instrumented main connection (null when disabled). */
export function getMainThreadDbRecorder(): DbCallRecorder | null {
  return recorder
}

export function getMainThreadPerfSnapshot(): { eventLoop: EventLoopSnapshot | null; db: DbPerfSnapshot | null } {
  return {
    eventLoop: histogram ? eventLoopSnapshot(histogram) : null,
    db: recorder ? recorder.snapshot() : null
  }
}

export function formatPerfReport(eventLoop: EventLoopSnapshot | null, db: DbPerfSnapshot | null): string {
  const lines: string[] = []
  if (eventLoop) {
    lines.push(
      `event loop delay ms (over the ${EVENT_LOOP_RESOLUTION_MS} ms tick): p50 ${eventLoop.p50.toFixed(1)} p95 ${eventLoop.p95.toFixed(1)} ` +
      `p99 ${eventLoop.p99.toFixed(1)} max ${eventLoop.max.toFixed(1)} (samples ${eventLoop.count})`
    )
  }
  if (db) {
    lines.push(
      `db: ${db.calls} calls, ${db.blockedMs.toFixed(1)} ms blocked, max ${db.maxMs.toFixed(1)} ms, ` +
      `>16ms ${db.over16ms}, >50ms ${db.over50ms}`
    )
    for (const s of db.slowest) {
      lines.push(`  max ${s.maxMs.toFixed(1)} ms, total ${s.totalMs.toFixed(1)} ms, n=${s.count} ${s.op}: ${s.sql}`)
    }
  }
  return lines.join('\n')
}

export function logMainThreadPerfReport(reason: string, reset = false): void {
  if (!histogram && !recorder) return
  const { eventLoop, db } = getMainThreadPerfSnapshot()
  console.log(`[perf] main thread (${reason})\n${formatPerfReport(eventLoop, db)}`)
  if (reset) {
    histogram?.reset()
    recorder?.reset()
  }
}

export function stopMainThreadPerf(): void {
  if (reportTimer) clearInterval(reportTimer)
  reportTimer = null
  histogram?.disable()
  histogram = null
}
