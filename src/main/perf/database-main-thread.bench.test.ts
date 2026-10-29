/**
 * Main-thread cost of better-sqlite3 per user scenario.
 *
 * SKIPPED unless `TWENTYX_PERF_DB` is set, so CI never runs it:
 *
 *   # a COPY of a real database (never point this at the live file)
 *   TWENTYX_PERF_DB=/tmp/copy/pf-desktop.db pnpm test:main -- src/main/perf/database-main-thread.bench.test.ts
 *   # or a generated large database
 *   TWENTYX_PERF_DB=synthetic pnpm test:main -- src/main/perf/database-main-thread.bench.test.ts
 *
 * It drives the REAL DatabaseManager (production `initialize()`, DDL, indexes,
 * pragmas) through the same calls the IPC handlers and AgentManager make, with
 * timers between calls so the event loop runs as it would in the app. Every
 * better-sqlite3 call goes through the TWENTYX_PERF instrumentation
 * (`main-thread-perf.ts`); event-loop delay is sampled with
 * `monitorEventLoopDelay`. No Electron window, IPC serialization or renderer
 * work is included: the numbers are the database share of main-thread time.
 *
 * Scenarios: app start, task list load, agent streaming (3 sessions writing
 * transcript parts at agent poll rates), task switch, and the cost a worker
 * would add back on the main thread (structured clone of results).
 *
 * Task-switch transcript reads go through `getTranscriptPartsAsync`, like the
 * app. Compare `TWENTYX_DB_READ_WORKER=0` (main thread) against the default
 * (read-only worker connection); "loop active ms" and the event-loop delay
 * include the main-thread cost of receiving the worker's result.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { builtinModules } from 'node:module'
import { build } from 'vite'
import { tmpdir } from 'node:os'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { app } from 'electron'
import { DatabaseManager } from '../database'
import { isDbReadWorkerEnabled } from '../db-read/db-read-client'
import { EVENT_LOOP_RESOLUTION_MS, eventLoopSnapshot, getMainThreadDbRecorder, type DbPerfSnapshot, type EventLoopSnapshot } from './main-thread-perf'

vi.mock('../task-api-server', () => ({ startTaskApiServer: vi.fn(async () => 1234) }))

const TARGET = process.env.TWENTYX_PERF_DB
const STREAM_SECONDS = Number(process.env.TWENTYX_PERF_STREAM_SECONDS) || 20

interface ScenarioResult {
  name: string
  wallMs: number
  /** Event-loop active time (performance.eventLoopUtilization), all main-thread work. */
  activeMs: number
  /** Sum of synchronous handler time (DB + JS row mapping), i.e. main thread blocked. */
  handlerMs: number
  db: DbPerfSnapshot
  loop: EventLoopSnapshot
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(!TARGET)('main-thread better-sqlite3 cost per scenario', { timeout: 1_800_000 }, () => {
  let dir: string
  let ownsDir = false
  let db: DatabaseManager
  const results: ScenarioResult[] = []
  const extra: Record<string, string> = {}
  let handlerMs = 0

  /** One synchronous main-process handler (what an IPC handler or AgentManager does). */
  function step<T>(fn: () => T): T {
    const start = performance.now()
    try {
      return fn()
    } finally {
      handlerMs += performance.now() - start
    }
  }

  async function scenario(name: string, body: () => Promise<void>): Promise<ScenarioResult> {
    getMainThreadDbRecorder()?.reset()
    handlerMs = 0
    const histogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS })
    histogram.enable()
    const elu = performance.eventLoopUtilization()
    const start = performance.now()
    await body()
    await sleep(20) // let the histogram sample after the last blocking call
    const wallMs = performance.now() - start
    const activeMs = performance.eventLoopUtilization(elu).active
    histogram.disable()
    // initialize() creates the recorder on the first open, so read it afterwards.
    const result = { name, wallMs, activeMs, handlerMs, db: getMainThreadDbRecorder()!.snapshot(10), loop: eventLoopSnapshot(histogram) }
    results.push(result)
    return result
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (): any => (db as any).db

  function seedSynthetic(): void {
    const OPEN = 1000
    const COMPLETED = 4000
    const LINKED = 500
    const source = db.createTaskSource({ mcp_server_id: null, name: 'Workflo', plugin_id: 'peakflo' })!
    const snapshot = JSON.stringify({
      id: 'remote', title: 'Remote task', status: 'not_started', cron: null, executionMode: 'agent',
      spaceName: 'Space', metadata: { triage: { reason: 'r'.repeat(400) } }, description: 'd'.repeat(1500)
    })
    const ids: string[] = []
    raw().transaction(() => {
      for (let i = 0; i < OPEN + COMPLETED; i++) {
        const linked = i < LINKED
        const task = db.createTask({
          title: `Task ${i}`,
          description: `Description ${i} `.repeat(30),
          status: i < OPEN ? (i % 4 === 0 ? 'agent_working' : 'not_started') : 'completed',
          labels: ['a', 'b'],
          ...(linked ? { source_id: source.id, external_id: `ext-${i}` } : {})
        })!
        ids.push(task.id)
        if (linked) db.setSetting(`workflo-task:${task.id}`, snapshot)
      }
      const insertInterval = raw().prepare(`
        INSERT INTO agent_run_intervals (id, task_id, agent_id, session_id, provider, harness_instance_id, started_at_ms, ended_at_ms, end_reason)
        VALUES (?, ?, 'agent', ?, 'claude-code', NULL, ?, ?, 'idle')
      `)
      for (let i = 0; i < 20_000; i++) {
        const start = 1_750_000_000_000 + i * 60_000
        insertInterval.run(`iv-${i}`, ids[i % ids.length], `s-${i}`, start, start + 30_000)
      }
      const insertPart = raw().prepare(`
        INSERT INTO transcript_parts (task_id, part_id, seq, role, content, part_type, tool, payload, created_at, updated_at, rev)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      `)
      const tool = JSON.stringify({ name: 'Bash', input: { command: 'ls -la' }, output: 'o'.repeat(4000), status: 'completed' })
      let rev = 0
      // 10 very long transcripts (3,000 parts) + 190 ordinary ones (300 parts).
      for (let t = 0; t < 200; t++) {
        const parts = t < 10 ? 3000 : 300
        for (let p = 0; p < parts; p++) {
          rev++
          const isTool = p % 3 === 0
          insertPart.run(ids[t], `p-${p}`, p + 1, isTool ? 'assistant' : (p % 10 === 1 ? 'user' : 'assistant'),
            isTool ? '' : 'x'.repeat(200 + (p % 7) * 400), isTool ? 'tool' : 'text', isTool ? tool : null, rev, rev, rev)
        }
      }
    })()
  }

  /** Mirrors index.ts startup DB work and the renderer's first loads. */
  function appStart(): void {
    db = new DatabaseManager()
    db.readWorkerScriptPath = workerScript
    step(() => db.initialize())
    step(() => db.getSetting('enterprise_brand_spaces'))
    step(() => db.getSetting('enterprise_user_email'))
    step(() => ({ taskCount: db.getTasks().length, agentCount: db.getAgents().length }))
  }

  function taskListLoad(): string[] {
    const open = step(() => db.getOpenTasks())
    step(() => db.getCompletedTaskStats(new Date(Date.now() - 7 * 86_400_000).toISOString()))
    step(() => db.getCompletedTasksPage(0, 50))
    const ids = open.map((t) => t.id)
    step(() => db.getTaskRunDurations(ids))
    return ids
  }

  let workerScript: string | undefined
  const workerOutDir = resolve(__dirname, '../../../node_modules/.cache/20x-db-read-worker-bench')

  beforeAll(async () => {
    process.env.TWENTYX_PERF = '1'
    extra['read worker'] = isDbReadWorkerEnabled() ? 'ON (TWENTYX_DB_READ_WORKER != 0)' : 'OFF (TWENTYX_DB_READ_WORKER=0)'
    if (isDbReadWorkerEnabled()) {
      await build({
        logLevel: 'silent',
        configFile: false,
        build: {
          outDir: workerOutDir,
          emptyOutDir: true,
          ssr: true,
          minify: false,
          lib: { entry: resolve(__dirname, '../db-read/db-read-worker.ts'), formats: ['cjs'], fileName: () => 'db-read-worker.js' },
          rollupOptions: { external: ['better-sqlite3', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)] }
        }
      })
      workerScript = join(workerOutDir, 'db-read-worker.js')
    }
    if (TARGET === 'synthetic') {
      dir = mkdtempSync(join(tmpdir(), '20x-db-main-thread-'))
      ownsDir = true
      vi.mocked(app.getPath).mockReturnValue(dir)
      db = new DatabaseManager()
      db.readWorkerScriptPath = workerScript
      db.initialize()
      seedSynthetic()
      db.close()
    } else {
      if (!existsSync(TARGET!)) throw new Error(`TWENTYX_PERF_DB not found: ${TARGET}`)
      if (basename(TARGET!) !== 'pf-desktop.db') throw new Error('TWENTYX_PERF_DB must point at a pf-desktop.db copy')
      dir = dirname(TARGET!)
      vi.mocked(app.getPath).mockReturnValue(dir)
    }
  }, 600_000)

  afterAll(() => {
    const fmt = (n: number): string => n.toFixed(1)
    const lines = [`[perf] main-thread DB benchmark (${TARGET})`]
    lines.push('scenario | wall ms | loop active ms | handler ms | db ms | db share of loop active | db calls | max call ms | >16ms | >50ms | loop delay p50/p95/p99/max ms')
    for (const r of results) {
      lines.push([
        r.name, fmt(r.wallMs), fmt(r.activeMs), fmt(r.handlerMs), fmt(r.db.blockedMs),
        `${r.activeMs > 0 ? Math.round((r.db.blockedMs / r.activeMs) * 100) : 0}%`,
        r.db.calls, fmt(r.db.maxMs), r.db.over16ms, r.db.over50ms,
        `${fmt(r.loop.p50)}/${fmt(r.loop.p95)}/${fmt(r.loop.p99)}/${fmt(r.loop.max)}`
      ].join(' | '))
    }
    for (const r of results) {
      lines.push(`-- ${r.name}: slowest statements (max single call)`)
      for (const s of r.db.slowest) {
        lines.push(`   max ${fmt(s.maxMs)} total ${fmt(s.totalMs)} n=${s.count} ${s.op}: ${s.sql.slice(0, 120)}`)
      }
    }
    for (const [k, v] of Object.entries(extra)) lines.push(`${k}: ${v}`)
    console.log(lines.join('\n'))
    db?.close()
    if (ownsDir) rmSync(dir, { recursive: true, force: true })
    rmSync(workerOutDir, { recursive: true, force: true })
  }, 120_000)

  let openIds: string[] = []
  let transcriptTasks: Array<{ id: string; n: number }> = []

  it('app start (initialize + startup reads + first task list load)', async () => {
    // First open of this file in the run: includes OS page-cache warm-up.
    const cold = await scenario('app start (1st open)', async () => {
      appStart()
      await sleep(50)
      openIds = taskListLoad()
    })
    db.close()
    await sleep(200)
    await scenario('app start (2nd open)', async () => {
      appStart()
      await sleep(50)
      taskListLoad()
    })
    expect(cold.db.calls).toBeGreaterThan(0)
  })

  it('task list load (x10, 500 ms apart)', async () => {
    await scenario('task list load x10', async () => {
      for (let i = 0; i < 10; i++) {
        taskListLoad()
        await sleep(500)
      }
    })
  })

  it('task switch (20 switches, 300 ms apart)', async () => {
    // Largest transcripts first (worst case), then the most recent ones.
    const biggest = raw().prepare(
      'SELECT task_id AS id, COUNT(*) AS n FROM transcript_parts WHERE task_id IN (SELECT id FROM tasks) GROUP BY task_id ORDER BY n DESC LIMIT 5'
    ).all() as Array<{ id: string; n: number }>
    const recent = raw().prepare(
      'SELECT tp.task_id AS id, COUNT(*) AS n FROM transcript_parts tp JOIN tasks t ON t.id = tp.task_id GROUP BY tp.task_id ORDER BY MAX(t.updated_at) DESC LIMIT 20'
    ).all() as Array<{ id: string; n: number }>
    transcriptTasks = [...biggest, ...recent.filter((r) => !biggest.some((b) => b.id === r.id))].slice(0, 20)
    extra['task switch: transcript part counts'] = transcriptTasks.map((t) => t.n).join(', ')

    await scenario('task switch x20', async () => {
      for (const t of transcriptTasks) {
        step(() => db.getTask(t.id))
        // agentSession:getTranscriptSnapshot -> AgentManager.getTranscriptSnapshot
        // Same as AgentManager.getTranscriptSnapshot: read worker when enabled.
        if (step(() => db.hasTranscriptParts(t.id))) await db.getTranscriptPartsAsync(t.id)
        step(() => db.getSubtasks(t.id))
        step(() => db.getHeartbeatLogs(t.id))
        await sleep(300)
      }
    })
  })

  it(`agent streaming (3 sessions, ${STREAM_SECONDS}s)`, async () => {
    const streamTasks = (openIds.length >= 3 ? openIds : transcriptTasks.map((t) => t.id)).slice(0, 3)
    const recorderLines: string[] = []
    const sessions = streamTasks.map((taskId, i) => ({ taskId, text: '', part: 0, toolEvery: 20 + i * 3, ticks: 0 }))
    const pending = new Map<string, number>()
    let sendBytes = 0

    await scenario(`agent streaming 3x${STREAM_SECONDS}s`, async () => {
      for (const s of sessions) step(() => db.updateTask(s.taskId, { status: 'agent_working' } as never))
      const stopAt = performance.now() + STREAM_SECONDS * 1000
      // AgentManager polls each session about every 100 ms and writes the batch
      // through persistTranscriptEvent -> upsertTranscriptParts; transcript:changed
      // is coalesced and flushed every 125 ms through getTranscriptDelta.
      const pollers = sessions.map((s) => (async () => {
        while (performance.now() < stopAt) {
          s.ticks++
          s.text += 'token '.repeat(8)
          if (s.text.length > 20_000) { s.part++; s.text = '' }
          const parts: Parameters<DatabaseManager['upsertTranscriptParts']>[1] = [
            { id: `bench-${s.part}`, role: 'assistant', content: s.text || '…', partType: 'text' }
          ]
          if (s.ticks % s.toolEvery === 0) {
            parts.push({ id: `bench-tool-${s.ticks}`, role: 'assistant', content: '', partType: 'tool',
              tool: { name: 'Read', input: { file_path: '/x' }, output: 'o'.repeat(2000), status: 'completed' } })
          }
          const r = step(() => db.upsertTranscriptParts(s.taskId, parts))
          const prev = pending.get(s.taskId)
          const since = r.maxRev - r.changedPartIds.length
          pending.set(s.taskId, prev === undefined ? since : Math.min(prev, since))
          await sleep(100)
        }
      })())
      const flusher = (async () => {
        while (performance.now() < stopAt) {
          await sleep(125)
          for (const [taskId, since] of pending) {
            const delta = step(() => db.getTranscriptDelta(taskId, since))
            sendBytes += delta.parts.reduce((n, p) => n + p.content.length, 0)
          }
          pending.clear()
        }
      })()
      const sidebar = (async () => {
        while (performance.now() < stopAt) {
          await sleep(5000)
          step(() => db.getTaskRunDurations(openIds))
        }
      })()
      await Promise.all([...pollers, flusher, sidebar])
    })
    recorderLines.push(`delta text bytes sent: ${sendBytes}`)
    extra['agent streaming'] = recorderLines.join('; ')

    // Turn end (working -> idle): index.ts speech watcher and AgentManager both
    // load the FULL transcript (sibling task covers these full loads).
    await scenario('turn end (full transcript loads) x3', async () => {
      for (const s of sessions) {
        step(() => db.getTranscriptParts(s.taskId))
        step(() => db.getTranscriptParts(s.taskId).length > 0)
        step(() => db.updateTask(s.taskId, { status: 'ready_for_review' } as never))
        await sleep(100)
      }
    })
  })

  it('cost a worker would add back on the main thread (structured clone of results)', () => {
    const time = (fn: () => unknown): string => {
      const value = fn()
      const start = performance.now()
      structuredClone(value)
      return `${(performance.now() - start).toFixed(1)} ms (${(JSON.stringify(value).length / 1024).toFixed(0)} KB)`
    }
    extra['clone getOpenTasks'] = time(() => db.getOpenTasks())
    extra['clone getCompletedTasksPage(0,50)'] = time(() => db.getCompletedTasksPage(0, 50))
    extra['clone getTaskRunDurations(open)'] = time(() => db.getTaskRunDurations(openIds))
    if (transcriptTasks[0]) extra['clone largest getTranscriptParts'] = time(() => db.getTranscriptParts(transcriptTasks[0].id))
  })
})

