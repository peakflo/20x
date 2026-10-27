/**
 * Small helpers shared by the `*.perf.test.ts` benchmarks.
 *
 * Timings are printed, not asserted tightly: CI machines vary. Deterministic
 * work counters (statements, rows, bytes) are what the assertions guard.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { vi } from 'vitest'
import { app } from 'electron'
import { DatabaseManager } from '../../src/main/database'

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** Median wall time of `fn` over `runs` runs, after one warm-up run. */
export async function timeAsync(runs: number, fn: () => unknown): Promise<number> {
  await fn()
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    await fn()
    samples.push(performance.now() - start)
  }
  return median(samples)
}

/**
 * A file-backed database created through the REAL `initialize()` (production
 * DDL, indexes and pragmas), in a fresh temp directory.
 */
export function createPerfDb(prefix: string): {
  db: DatabaseManager
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any
  cleanup: () => void
} {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  vi.mocked(app.getPath).mockReturnValue(dir)
  const db = new DatabaseManager()
  db.initialize()
  return {
    db,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw: (db as any).db,
    cleanup: () => {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

export interface StatementCounts {
  executed: number
  rows: number
}

/**
 * Counts statements executed (`get`/`all`/`run`/`iterate`) and rows returned
 * by them while `fn` runs, by wrapping the raw better-sqlite3 `prepare`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function countStatements(raw: any, fn: () => unknown): Promise<StatementCounts> {
  const prepare = raw.prepare
  const counts: StatementCounts = { executed: 0, rows: 0 }
  raw.prepare = (sql: string) => {
    const stmt = prepare.call(raw, sql)
    return new Proxy(stmt, {
      get(target, key) {
        const value = Reflect.get(target, key)
        if (key === 'get' || key === 'all' || key === 'run') {
          return (...args: unknown[]) => {
            counts.executed++
            const result = value.apply(target, args)
            if (key === 'all') counts.rows += (result as unknown[]).length
            else if (key === 'get' && result !== undefined) counts.rows++
            return result
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }
  try {
    await fn()
  } finally {
    raw.prepare = prepare
  }
  return counts
}

export function printResults(title: string, results: Record<string, string | number>): void {
  console.log(`[perf] ${title}\n` + Object.entries(results).map(([k, v]) => `  ${k}: ${v}`).join('\n'))
}
