/**
 * Main-process cost of the hot database paths on a realistically sized,
 * file-backed database created through the REAL `initialize()` (production
 * DDL, indexes and pragmas).
 *
 * Seed: 2,000 open tasks (500 of them linked to a Peakflo/Workflo source with
 * a server snapshot), 20,000 agent run intervals, 50,000 transcript parts.
 *
 * Hot paths measured:
 * - `getOpenTasks()` — every renderer task-list load and refresh.
 * - `getTaskRunDurations(allIds)` — the sidebar polls this every 5 s.
 * - `upsertTranscriptParts()` — one write transaction per streamed agent batch.
 *
 * Timings are printed (`[perf] database benchmark`). Assertions are loose
 * guards so the suite is not flaky on slow CI machines.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { DatabaseManager } from './database'

const TASKS = 2000
const LINKED = 500
const INTERVALS = 20_000
const TRANSCRIPT_TASKS = 100
const PARTS_PER_TASK = 500

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function time(runs: number, fn: () => void): number {
  fn() // warm-up
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    fn()
    samples.push(performance.now() - start)
  }
  return median(samples)
}

describe('database hot-path benchmark', { timeout: 120_000 }, () => {
  let dir: string
  let db: DatabaseManager
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let raw: any
  let taskIds: string[] = []
  const results: Record<string, string | number> = {}

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), '20x-db-perf-'))
    vi.mocked(app.getPath).mockReturnValue(dir)
    db = new DatabaseManager()
    db.initialize()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw = (db as any).db

    const source = db.createTaskSource({ mcp_server_id: null, name: 'Workflo', plugin_id: 'peakflo' })!
    const snapshot = JSON.stringify({
      id: 'remote', title: 'Remote task', status: 'not_started', cron: null, executionMode: 'agent',
      spaceName: 'Space', metadata: { triage: { reason: 'r'.repeat(400) } }, description: 'd'.repeat(1500)
    })
    raw.transaction(() => {
      for (let i = 0; i < TASKS; i++) {
        const linked = i < LINKED
        const task = db.createTask({
          title: `Task ${i}`,
          description: `Description ${i} `.repeat(10),
          status: i % 3 === 0 ? 'agent_working' : 'not_started',
          labels: ['a', 'b'],
          ...(linked ? { source_id: source.id, external_id: `ext-${i}` } : {})
        })!
        taskIds.push(task.id)
        if (linked) db.setSetting(`workflo-task:${task.id}`, snapshot)
      }
      const insertInterval = raw.prepare(`
        INSERT INTO agent_run_intervals (id, task_id, agent_id, session_id, provider, harness_instance_id, started_at_ms, ended_at_ms, end_reason)
        VALUES (?, ?, 'agent', ?, 'claude-code', NULL, ?, ?, 'idle')
      `)
      for (let i = 0; i < INTERVALS; i++) {
        const start = 1_750_000_000_000 + i * 60_000
        insertInterval.run(`iv-${i}`, taskIds[i % TASKS], `s-${i}`, start, start + 30_000)
      }
      const insertPart = raw.prepare(`
        INSERT INTO transcript_parts (task_id, part_id, seq, role, content, part_type, tool, payload, created_at, updated_at, rev)
        VALUES (?, ?, ?, 'assistant', ?, 'text', NULL, NULL, ?, ?, ?)
      `)
      let rev = 0
      for (let t = 0; t < TRANSCRIPT_TASKS; t++) {
        for (let p = 0; p < PARTS_PER_TASK; p++) {
          rev++
          insertPart.run(taskIds[t], `p-${p}`, p + 1, 'x'.repeat(300), rev, rev, rev)
        }
      }
    })()
    taskIds = taskIds.slice()
  })

  afterAll(() => {
    console.log('[perf] database benchmark\n' + Object.entries(results).map(([k, v]) => `  ${k}: ${v}`).join('\n'))
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('loads the open task set', () => {
    expect(db.getOpenTasks()).toHaveLength(TASKS)
    results['getOpenTasks (2k tasks, 500 linked), median ms'] = time(15, () => db.getOpenTasks()).toFixed(2)

    // Deterministic work counter: statements prepared and executed per call.
    const prepare = raw.prepare.bind(raw)
    let prepared = 0
    let executed = 0
    raw.prepare = (sql: string) => {
      prepared++
      const stmt = prepare(sql)
      return new Proxy(stmt, {
        get(target, key) {
          const value = Reflect.get(target, key)
          if (key === 'get' || key === 'all' || key === 'run') {
            return (...args: unknown[]) => { executed++; return value.apply(target, args) }
          }
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }
    try {
      db.getOpenTasks()
    } finally {
      raw.prepare = prepare
    }
    results['getOpenTasks: statements prepared / executed per call'] = `${prepared} / ${executed}`
    expect(prepared).toBeLessThan(20)
  })

  it('reads run durations for every open task', () => {
    expect(Object.keys(db.getTaskRunDurations(taskIds))).toHaveLength(TASKS)
    results['getTaskRunDurations (2k ids, 20k intervals), median ms'] = time(15, () => db.getTaskRunDurations(taskIds)).toFixed(2)
    const plan = raw.prepare(
      'EXPLAIN QUERY PLAN SELECT task_id, SUM(started_at_ms) FROM agent_run_intervals WHERE task_id IN (?, ?) GROUP BY task_id'
    ).all('a', 'b').map((r: { detail: string }) => r.detail).join(' | ')
    results['run durations query plan'] = plan
    expect(plan).toContain('idx_agent_run_intervals_task')
  })

  it('writes one streamed transcript update', () => {
    results['PRAGMA synchronous'] = raw.pragma('synchronous', { simple: true })
    let n = 0
    const text = 'y'.repeat(8000)
    results['upsertTranscriptParts (1 growing 8 KB part), median ms'] = time(200, () => {
      n++
      db.upsertTranscriptParts(taskIds[0], [{ id: 'live', role: 'assistant', content: text + n, partType: 'text' }])
    }).toFixed(3)
  })
})
