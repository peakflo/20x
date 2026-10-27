/**
 * Main-process cost of one TaskAutomationScheduler reconciliation pass.
 *
 * The pass runs every 60 s and after every status change (`runNow`). Its
 * flag query does not filter on status, so every top-level task that was ever
 * created with `auto_start_agent` (recurring instances inherit it) stays in
 * the sweep for ever — the flagged set only grows.
 *
 * Seed per size N (real file-backed DB through the production `initialize()`):
 * N flagged top-level tasks — 80% completed history, 10% waiting in
 * agent_working, 10% coordinators with 3 subtasks (one running) — plus 5% of N
 * auto-complete tasks in review that still have a pending subtask.
 * Nothing is startable, so the pass is pure bookkeeping (the steady state).
 *
 * Printed: statements executed, rows read and median ms per pass.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { TaskAutomationScheduler } from './task-automation-scheduler'
import { TaskStatus } from '../shared/constants'
import type { AgentManager } from './agent-manager'
import { countStatements, createPerfDb, printResults, timeAsync } from '../../test/helpers/perf-helpers'

const SIZES = [50, 200, 1000]
const results: Record<string, string | number> = {}

afterAll(() => printResults('task automation scheduler: one reconciliation pass', results))

describe('task automation scheduler benchmark', { timeout: 120_000 }, () => {
  for (const size of SIZES) {
    it(`one pass with ${size} flagged tasks`, async () => {
      const { db, raw, cleanup } = createPerfDb('20x-automation-perf-')
      try {
        const agent = db.createAgent({ name: 'Agent', server_url: 'http://localhost', config: {} } as never)!
        raw.transaction(() => {
          for (let i = 0; i < size; i++) {
            const kind = i % 10
            const status = kind < 8 ? TaskStatus.Completed : TaskStatus.AgentWorking
            const task = db.createTask({ title: `Flagged ${i}`, status, auto_start_agent: true })!
            if (kind === 9) {
              for (let s = 0; s < 3; s++) {
                const sub = db.createTask({
                  title: `Sub ${i}.${s}`,
                  parent_task_id: task.id,
                  status: s === 0 ? TaskStatus.AgentWorking : TaskStatus.NotStarted
                })!
                raw.prepare('UPDATE tasks SET agent_id = ?, sort_order = ? WHERE id = ?').run(agent.id, s, sub.id)
              }
            }
          }
          for (let i = 0; i < Math.ceil(size / 20); i++) {
            const parent = db.createTask({
              title: `Review ${i}`, status: TaskStatus.ReadyForReview, auto_complete_without_review: true
            })!
            db.createTask({ title: `Pending sub ${i}`, parent_task_id: parent.id, status: TaskStatus.NotStarted })
          }
        })()

        const agentManager = {
          hasActiveSessionForTask: vi.fn(() => false),
          startTask: vi.fn(async () => ({ action: 'started' })),
          completeTaskWithoutReview: vi.fn(async () => true)
        } as unknown as AgentManager
        const scheduler = new TaskAutomationScheduler(db, agentManager)
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})

        const counts = await countStatements(raw, () => scheduler.runNow())
        const ms = await timeAsync(15, () => scheduler.runNow())
        log.mockRestore()

        // Steady state: nothing to start or complete.
        expect(agentManager.startTask).not.toHaveBeenCalled()
        expect(agentManager.completeTaskWithoutReview).not.toHaveBeenCalled()
        results[`N=${size}: statements / rows per pass`] = `${counts.executed} / ${counts.rows}`
        results[`N=${size}: median ms per pass`] = ms.toFixed(2)
        // One statement per flag query plus the subtask lookup, not per task.
        expect(counts.executed).toBeLessThan(10)
      } finally {
        cleanup()
      }
    })
  }
})
