import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { DbCallRecorder, instrumentDatabase, instrumentMainDatabase, isMainThreadPerfEnabled } from './main-thread-perf'

describe('main-thread perf instrumentation', () => {
  it('is off unless TWENTYX_PERF=1 and then returns the connection untouched', () => {
    expect(isMainThreadPerfEnabled({})).toBe(false)
    expect(isMainThreadPerfEnabled({ TWENTYX_PERF: '1' })).toBe(true)
    const raw = new Database(':memory:')
    try {
      expect(instrumentMainDatabase(raw, {})).toBe(raw)
    } finally {
      raw.close()
    }
  })

  it('times statements and counts a transaction once at the outer level', () => {
    const recorder = new DbCallRecorder()
    const db = instrumentDatabase(new Database(':memory:'), recorder)
    try {
      expect(db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')).toBe(db)
      const insert = db.prepare('INSERT INTO t (v) VALUES (?)')
      const insertMany = db.transaction((values: string[]) => {
        for (const v of values) insert.run(v)
      })
      insertMany.immediate(['a', 'b', 'c'])
      expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 3 })
      expect(db.prepare('SELECT v FROM t ORDER BY id').pluck().all()).toEqual(['a', 'b', 'c'])
      expect([...db.prepare('SELECT v FROM t').iterate()]).toHaveLength(3)
      expect(db.pragma('user_version', { simple: true })).toBe(0)
      expect(db.open).toBe(true)

      const snap = recorder.snapshot(50)
      const run = snap.heaviest.find((s) => s.op === 'run')!
      expect(run.count).toBe(3)
      const txn = snap.heaviest.find((s) => s.op === 'transaction')!
      expect(txn.count).toBe(1)
      // exec, 4 prepares... are outer calls; the 3 runs inside the transaction are not.
      const outerOps = snap.calls
      const allOps = snap.heaviest.reduce((n, s) => n + s.count, 0)
      expect(allOps - outerOps).toBe(3)

      recorder.reset()
      expect(recorder.snapshot().calls).toBe(0)
    } finally {
      db.close()
    }
  })

  it('reports calls over the slow threshold', () => {
    const slow: string[] = []
    const recorder = new DbCallRecorder(({ sql }) => slow.push(sql))
    recorder.time('all', 'SELECT slow', () => {
      const until = performance.now() + 55
      while (performance.now() < until) { /* busy */ }
    })
    const snap = recorder.snapshot()
    expect(snap.over16ms).toBe(1)
    expect(snap.over50ms).toBe(1)
    expect(slow).toEqual(['SELECT slow'])
  })
})
