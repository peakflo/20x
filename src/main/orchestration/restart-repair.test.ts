import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { makeTask } from '../../../test/helpers/task-fixtures'
import type { DatabaseManager } from '../database'
import { TaskStatus } from '../../shared/constants'
import { runRestartRepair, type RestartRepairAgentManager } from './restart-repair'

let db: DatabaseManager
let rawDb: import('better-sqlite3').Database

beforeEach(() => {
  ;({ db, rawDb } = createTestDb())
  // task_wakeups is normally created lazily by TaskWakeupStore's constructor
  // (see orchestration/task-wakeups.ts) — create it directly here since these
  // tests check restart-repair's "has a pending wake-up" query in isolation.
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS task_wakeups (
      id TEXT PRIMARY KEY,
      parent_task_id TEXT NOT NULL,
      child_task_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
  `)
})

function fakeAgentManager(overrides: Partial<RestartRepairAgentManager> = {}): RestartRepairAgentManager {
  return {
    findSessionByTaskId: vi.fn(() => undefined),
    startTask: vi.fn(async () => ({ action: 'task_started' })),
    ...overrides
  }
}

function setSessionId(taskId: string, sessionId: string | null): void {
  rawDb.prepare('UPDATE tasks SET session_id = ? WHERE id = ?').run(sessionId, taskId)
}

describe('runRestartRepair', () => {
  it('leaves a genuinely live session alone — never clobbers real work', async () => {
    const task = db.createTask(makeTask({ status: TaskStatus.AgentWorking }))!
    const agentManager = fakeAgentManager({ findSessionByTaskId: vi.fn(() => ({ sessionId: 'live-session' })) })

    const summary = await runRestartRepair(db, agentManager)

    expect(summary.autoResumed).toEqual([])
    expect(summary.needsResume).toEqual([])
    expect(summary.needsAttention).toEqual([])
    expect(db.getTask(task.id)!.status).toBe(TaskStatus.AgentWorking)
  })

  it('an agent_working task with a saved session and no auto chain needs a manual Resume', async () => {
    const task = db.createTask(makeTask({ status: TaskStatus.AgentWorking }))!
    setSessionId(task.id, 'saved-session-1')
    const agentManager = fakeAgentManager()

    const summary = await runRestartRepair(db, agentManager)

    expect(summary.needsResume).toEqual([task.id])
    expect(agentManager.startTask).not.toHaveBeenCalled()
    expect(db.getTask(task.id)!.status).toBe(TaskStatus.ModelError)
  })

  it('an agent_working task with no saved session needs attention — nothing can resume it', async () => {
    const task = db.createTask(makeTask({ status: TaskStatus.AgentWorking }))!
    const agentManager = fakeAgentManager()

    const summary = await runRestartRepair(db, agentManager)

    expect(summary.needsAttention).toEqual([task.id])
    expect(agentManager.startTask).not.toHaveBeenCalled()
    expect(db.getTask(task.id)!.status).toBe(TaskStatus.ModelError)
  })

  it('auto-resumes a resumable task that is flagged auto_start_agent', async () => {
    const task = db.createTask(makeTask({ status: TaskStatus.AgentWorking, auto_start_agent: true }))!
    setSessionId(task.id, 'saved-session-2')
    const agentManager = fakeAgentManager()

    const summary = await runRestartRepair(db, agentManager)

    expect(summary.autoResumed).toEqual([task.id])
    expect(agentManager.startTask).toHaveBeenCalledWith(task.id, { preferSubtasks: false, allowTriage: false })
  })

  it('auto-resumes a resumable task that has a pending wake-up waiting on it (it is a parent someone is waiting for)', async () => {
    const parent = db.createTask(makeTask({ status: TaskStatus.AgentWorking }))!
    setSessionId(parent.id, 'saved-session-3')
    rawDb.prepare(`
      INSERT INTO task_wakeups (id, parent_task_id, child_task_id, reason, delivery_id, payload, created_at, delivered_at, attempts, last_error)
      VALUES ('w1', ?, 'child-1', 'child_ready', 'delivery-1', '{}', ?, NULL, 0, NULL)
    `).run(parent.id, Date.now())
    const agentManager = fakeAgentManager()

    const summary = await runRestartRepair(db, agentManager)

    expect(summary.autoResumed).toEqual([parent.id])
  })

  it('does not auto-resume a resumable task whose pending wake-up has already been delivered', async () => {
    const parent = db.createTask(makeTask({ status: TaskStatus.AgentWorking }))!
    setSessionId(parent.id, 'saved-session-4')
    rawDb.prepare(`
      INSERT INTO task_wakeups (id, parent_task_id, child_task_id, reason, delivery_id, payload, created_at, delivered_at, attempts, last_error)
      VALUES ('w2', ?, 'child-1', 'child_ready', 'delivery-2', '{}', ?, ?, 0, NULL)
    `).run(parent.id, Date.now(), Date.now())
    const agentManager = fakeAgentManager()

    const summary = await runRestartRepair(db, agentManager)

    expect(summary.needsResume).toEqual([parent.id])
    expect(summary.autoResumed).toEqual([])
  })

  it('falls back to manual resume when the auto-resume attempt itself throws', async () => {
    const task = db.createTask(makeTask({ status: TaskStatus.AgentWorking, auto_start_agent: true }))!
    setSessionId(task.id, 'saved-session-5')
    const agentManager = fakeAgentManager({ startTask: vi.fn(async () => { throw new Error('adapter unavailable') }) })

    const summary = await runRestartRepair(db, agentManager)

    expect(summary.autoResumed).toEqual([])
    expect(summary.needsResume).toEqual([task.id])
  })

  it('resets a triaging task to not_started instead of leaving it stuck', async () => {
    const task = db.createTask(makeTask({ status: TaskStatus.Triaging }))!
    const agentManager = fakeAgentManager()

    const summary = await runRestartRepair(db, agentManager)

    expect(summary.triagingReset).toEqual([task.id])
    expect(db.getTask(task.id)!.status).toBe(TaskStatus.NotStarted)
  })

  it('leaves a completed, not_started, or ready_for_review task alone', async () => {
    const completed = db.createTask(makeTask({ status: TaskStatus.Completed }))!
    const notStarted = db.createTask(makeTask({ status: TaskStatus.NotStarted }))!
    const review = db.createTask(makeTask({ status: TaskStatus.ReadyForReview }))!
    const agentManager = fakeAgentManager()

    const summary = await runRestartRepair(db, agentManager)

    expect(summary.autoResumed).toEqual([])
    expect(summary.needsResume).toEqual([])
    expect(summary.needsAttention).toEqual([])
    expect(summary.triagingReset).toEqual([])
    expect(db.getTask(completed.id)!.status).toBe(TaskStatus.Completed)
    expect(db.getTask(notStarted.id)!.status).toBe(TaskStatus.NotStarted)
    expect(db.getTask(review.id)!.status).toBe(TaskStatus.ReadyForReview)
  })

  it('writes a transcript note explaining the repair instead of silently flipping status', async () => {
    const task = db.createTask(makeTask({ status: TaskStatus.AgentWorking }))!
    const agentManager = fakeAgentManager()

    await runRestartRepair(db, agentManager)

    const parts = db.getTranscriptParts(task.id)
    expect(parts.some((p) => p.role === 'system' && p.content?.includes('Interrupted by restart'))).toBe(true)
  })

  it('closes any task_runs row left open from the previous run, with end_reason interrupted', async () => {
    const task = db.createTask(makeTask({ status: TaskStatus.AgentWorking }))!
    db.openTaskRun({ taskId: task.id, sessionId: 'crashed-session', startedAtMs: Date.now() - 1000 })
    const agentManager = fakeAgentManager()

    const summary = await runRestartRepair(db, agentManager)

    expect(summary.openRunsClosed).toBe(1)
    const run = db.getLatestTaskRun(task.id)
    expect(run?.endReason).toBe('interrupted')
    expect(run?.endedAt).not.toBeNull()
  })

  it('handles an empty database with no candidates', async () => {
    const agentManager = fakeAgentManager()
    const summary = await runRestartRepair(db, agentManager)
    expect(summary).toEqual({ autoResumed: [], needsResume: [], needsAttention: [], triagingReset: [], openRunsClosed: 0 })
  })
})
