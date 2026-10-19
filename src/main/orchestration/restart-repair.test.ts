import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { makeTask, makeAgent } from '../../../test/helpers/task-fixtures'
import type { DatabaseManager } from '../database'
import { TaskStatus } from '../../shared/constants'
import { AgentManager } from '../agent-manager'
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
      last_error TEXT,
      last_attempt_at INTEGER,
      given_up_at INTEGER
    );
  `)
  // usage_limit_recoveries is normally created lazily by UsageLimitRecoveryStore
  // (see usage/usage-limit-recovery.ts) — create it here for the same reason.
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS usage_limit_recoveries (
      task_id TEXT PRIMARY KEY,
      agent_id TEXT,
      provider TEXT,
      session_id TEXT,
      stopped_at INTEGER,
      reset_at INTEGER,
      auto_resume INTEGER,
      status TEXT NOT NULL,
      message TEXT,
      attempts INTEGER,
      resumed_at INTEGER,
      error TEXT
    );
  `)
})

/**
 * Real DB-backed fakes for the status-writing methods (applyLocalTaskUpdate,
 * markTaskModelError) so assertions on `db.getTask(...).status` still mean
 * something: a real AgentManager implementation of these also just ends up
 * calling `db.updateTask` under the server-managed guard, which these tests
 * don't otherwise exercise.
 */
function fakeAgentManager(overrides: Partial<RestartRepairAgentManager> = {}): RestartRepairAgentManager {
  return {
    findSessionByTaskId: vi.fn(() => undefined),
    startTask: vi.fn(async () => ({ action: 'task_started' })),
    // Native resume unavailable by default — tests that need it to succeed override this.
    resumeSession: vi.fn(async () => ''),
    sendByTaskId: vi.fn(async () => undefined),
    applyLocalTaskUpdate: vi.fn((taskId: string, updates: Record<string, unknown>) => db.updateTask(taskId, updates)),
    markTaskModelError: vi.fn((taskId: string) => db.updateTask(taskId, { status: TaskStatus.ModelError })),
    ...overrides
  }
}

function setSessionId(taskId: string, sessionId: string | null): void {
  rawDb.prepare('UPDATE tasks SET session_id = ? WHERE id = ?').run(sessionId, taskId)
}

function setAgentId(taskId: string, agentId: string | null): void {
  rawDb.prepare('UPDATE tasks SET agent_id = ? WHERE id = ?').run(agentId, taskId)
}

function setUsageLimitWaiting(taskId: string): void {
  rawDb.prepare(`
    INSERT INTO usage_limit_recoveries (task_id, agent_id, provider, session_id, stopped_at, reset_at, auto_resume, status, message, attempts, resumed_at, error)
    VALUES (?, 'agent-1', 'claude', 'saved-session', ?, ?, 1, 'waiting', 'limit hit', 0, NULL, NULL)
  `).run(taskId, Date.now(), Date.now() + 60_000)
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

  it('an agent_working task with a saved session and no auto chain needs a manual Resume, through markTaskModelError (not a raw DB write)', async () => {
    const task = db.createTask(makeTask({ status: TaskStatus.AgentWorking }))!
    setSessionId(task.id, 'saved-session-1')
    const agentManager = fakeAgentManager()

    const summary = await runRestartRepair(db, agentManager)

    expect(summary.needsResume).toEqual([task.id])
    expect(agentManager.startTask).not.toHaveBeenCalled()
    expect(agentManager.resumeSession).not.toHaveBeenCalled()
    expect(agentManager.markTaskModelError).toHaveBeenCalledWith(task.id)
    expect(db.getTask(task.id)!.status).toBe(TaskStatus.ModelError)
  })

  it('an agent_working task with no saved session needs attention — nothing can resume it', async () => {
    const task = db.createTask(makeTask({ status: TaskStatus.AgentWorking }))!
    const agentManager = fakeAgentManager()

    const summary = await runRestartRepair(db, agentManager)

    expect(summary.needsAttention).toEqual([task.id])
    expect(agentManager.startTask).not.toHaveBeenCalled()
    expect(agentManager.markTaskModelError).toHaveBeenCalledWith(task.id)
    expect(db.getTask(task.id)!.status).toBe(TaskStatus.ModelError)
  })

  it('does not flip a SERVER-MANAGED task\'s status — the Workflo-owned guard holds through the real AgentManager methods restart-repair calls', async () => {
    // Uses a REAL AgentManager (not the fake) wired to the same db, so this
    // proves the actual production guard (updateTaskFromLocalAgent, inside
    // applyLocalTaskUpdate/markTaskModelError) holds during restart repair —
    // not just that restart-repair calls the right-looking method names.
    const task = db.createTask(makeTask({ status: TaskStatus.AgentWorking }))!
    // Marks the task server-managed (see workflo-task-sync.ts's
    // serverTaskSnapshot, read by updateTaskFromLocalAgent).
    db.setSetting(`workflo-task:${task.id}`, JSON.stringify({ id: task.id, status: 'in_progress' }))

    const realAgentManager = new AgentManager(db)
    const summary = await runRestartRepair(db, realAgentManager)

    expect(summary.needsAttention).toEqual([task.id])
    // The server owns this task's status — restart repair must not flip it
    // locally, even though it "needs attention" from 20x's own point of view.
    expect(db.getTask(task.id)!.status).toBe(TaskStatus.AgentWorking)
  })

  it('auto-resumes NATIVELY (same session, a short continuation nudge) when the saved session can be resumed', async () => {
    const agent = db.createAgent(makeAgent())!
    const task = db.createTask(makeTask({ status: TaskStatus.AgentWorking, auto_start_agent: true }))!
    setSessionId(task.id, 'saved-session-2')
    setAgentId(task.id, agent.id)
    const agentManager = fakeAgentManager({ resumeSession: vi.fn(async () => 'saved-session-2') })

    const summary = await runRestartRepair(db, agentManager)

    expect(summary.autoResumed).toEqual([task.id])
    expect(agentManager.resumeSession).toHaveBeenCalledWith(agent.id, task.id, 'saved-session-2', { silent: true })
    expect(agentManager.sendByTaskId).toHaveBeenCalledWith(task.id, expect.stringContaining('restart'))
    // Native resume succeeded — must NOT also start a brand-new session,
    // which would re-send the original prompt and overwrite session_id.
    expect(agentManager.startTask).not.toHaveBeenCalled()
  })

  it('falls back to a fresh session (with the context handoff) only when native resume is not possible', async () => {
    const agent = db.createAgent(makeAgent())!
    const task = db.createTask(makeTask({ status: TaskStatus.AgentWorking, auto_start_agent: true }))!
    setSessionId(task.id, 'saved-session-2b')
    setAgentId(task.id, agent.id)
    // resumeAdapterSession's real contract: '' means "not resumed, caller starts a new session".
    const agentManager = fakeAgentManager({ resumeSession: vi.fn(async () => '') })

    const summary = await runRestartRepair(db, agentManager)

    expect(summary.autoResumed).toEqual([task.id])
    expect(agentManager.resumeSession).toHaveBeenCalledWith(agent.id, task.id, 'saved-session-2b', { silent: true })
    expect(agentManager.startTask).toHaveBeenCalledWith(task.id, { preferSubtasks: false, allowTriage: false })
    expect(agentManager.sendByTaskId).not.toHaveBeenCalled()
  })

  it('falls back to startTask without attempting resumeSession when the task has no agent_id', async () => {
    const task = db.createTask(makeTask({ status: TaskStatus.AgentWorking, auto_start_agent: true }))!
    setSessionId(task.id, 'saved-session-2c')
    const agentManager = fakeAgentManager()

    const summary = await runRestartRepair(db, agentManager)

    expect(summary.autoResumed).toEqual([task.id])
    expect(agentManager.resumeSession).not.toHaveBeenCalled()
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

  it('passes { silent: true } to resumeSession during repair — no dialog with nobody to answer it yet', async () => {
    const agent = db.createAgent(makeAgent())!
    const task = db.createTask(makeTask({ status: TaskStatus.AgentWorking, auto_start_agent: true }))!
    setSessionId(task.id, 'saved-session-silent')
    setAgentId(task.id, agent.id)
    const agentManager = fakeAgentManager({ resumeSession: vi.fn(async () => 'saved-session-silent') })

    await runRestartRepair(db, agentManager)

    expect(agentManager.resumeSession).toHaveBeenCalledWith(agent.id, task.id, 'saved-session-silent', { silent: true })
  })

  it('falls back to startTask (handoff) when resumeSession throws SESSION_INCOMPATIBLE, instead of a misleading "Resume to continue" note', async () => {
    const agent = db.createAgent(makeAgent())!
    const task = db.createTask(makeTask({ status: TaskStatus.AgentWorking, auto_start_agent: true }))!
    setSessionId(task.id, 'gone-session')
    setAgentId(task.id, agent.id)
    // Mirrors the real AgentManager.resumeAdapterSession: SESSION_INCOMPATIBLE
    // clears session_id as a side effect before throwing.
    const agentManager = fakeAgentManager({
      resumeSession: vi.fn(async () => {
        db.updateTask(task.id, { session_id: null })
        throw new Error('SESSION_INCOMPATIBLE')
      })
    })

    const summary = await runRestartRepair(db, agentManager)

    expect(summary.autoResumed).toEqual([task.id])
    expect(summary.needsResume).toEqual([])
    expect(agentManager.startTask).toHaveBeenCalledWith(task.id, { preferSubtasks: false, allowTriage: false })
    const parts = db.getTranscriptParts(task.id)
    expect(parts.some((p) => p.content?.includes('no longer valid'))).toBe(true)
    expect(parts.some((p) => p.content?.includes('Resume to continue'))).toBe(false)
  })

  it('lands in needsAttention (not the misleading needsResume) when the SESSION_INCOMPATIBLE fallback startTask also fails', async () => {
    const agent = db.createAgent(makeAgent())!
    const task = db.createTask(makeTask({ status: TaskStatus.AgentWorking, auto_start_agent: true }))!
    setSessionId(task.id, 'gone-session-2')
    setAgentId(task.id, agent.id)
    const agentManager = fakeAgentManager({
      resumeSession: vi.fn(async () => {
        db.updateTask(task.id, { session_id: null })
        throw new Error('SESSION_INCOMPATIBLE')
      }),
      startTask: vi.fn(async () => { throw new Error('no adapter available either') })
    })

    const summary = await runRestartRepair(db, agentManager)

    // session_id is already gone — "Resume to continue" would be a lie.
    expect(summary.needsResume).toEqual([])
    expect(summary.needsAttention).toEqual([task.id])
  })

  it('falls back to manual resume when resumeSession itself throws (not just returns empty)', async () => {
    const agent = db.createAgent(makeAgent())!
    const task = db.createTask(makeTask({ status: TaskStatus.AgentWorking, auto_start_agent: true }))!
    setSessionId(task.id, 'saved-session-5b')
    setAgentId(task.id, agent.id)
    const agentManager = fakeAgentManager({ resumeSession: vi.fn(async () => { throw new Error('harness crashed') }) })

    const summary = await runRestartRepair(db, agentManager)

    expect(summary.autoResumed).toEqual([])
    expect(summary.needsResume).toEqual([task.id])
    // A thrown resume is a genuine failure, not "not resumable" — don't
    // compound it by also trying a fresh session.
    expect(agentManager.startTask).not.toHaveBeenCalled()
  })

  it('resets a triaging task to not_started instead of leaving it stuck', async () => {
    const task = db.createTask(makeTask({ status: TaskStatus.Triaging }))!
    const agentManager = fakeAgentManager()

    const summary = await runRestartRepair(db, agentManager)

    expect(summary.triagingReset).toEqual([task.id])
    expect(agentManager.applyLocalTaskUpdate).toHaveBeenCalledWith(task.id, { status: TaskStatus.NotStarted })
    expect(db.getTask(task.id)!.status).toBe(TaskStatus.NotStarted)
  })

  it('skips a task entirely while a usage-limit recovery is waiting for it — that flow owns resuming it', async () => {
    const task = db.createTask(makeTask({ status: TaskStatus.AgentWorking, auto_start_agent: true }))!
    setSessionId(task.id, 'saved-session-6')
    setUsageLimitWaiting(task.id)
    const agentManager = fakeAgentManager()

    const summary = await runRestartRepair(db, agentManager)

    expect(summary.skippedUsageLimited).toEqual([task.id])
    expect(summary.autoResumed).toEqual([])
    expect(summary.needsResume).toEqual([])
    expect(summary.needsAttention).toEqual([])
    expect(agentManager.startTask).not.toHaveBeenCalled()
    expect(agentManager.resumeSession).not.toHaveBeenCalled()
    expect(agentManager.markTaskModelError).not.toHaveBeenCalled()
    // Left exactly as-is for the usage-limit-recovery sweep to continue.
    expect(db.getTask(task.id)!.status).toBe(TaskStatus.AgentWorking)
  })

  it('does not skip a task whose usage-limit recovery already resolved (status != waiting)', async () => {
    const task = db.createTask(makeTask({ status: TaskStatus.AgentWorking }))!
    rawDb.prepare(`
      INSERT INTO usage_limit_recoveries (task_id, status, stopped_at, reset_at)
      VALUES (?, 'resumed', ?, ?)
    `).run(task.id, Date.now(), Date.now())
    const agentManager = fakeAgentManager()

    const summary = await runRestartRepair(db, agentManager)

    expect(summary.skippedUsageLimited).toEqual([])
    expect(summary.needsAttention).toEqual([task.id])
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
    expect(summary).toEqual({
      autoResumed: [],
      needsResume: [],
      needsAttention: [],
      triagingReset: [],
      skippedUsageLimited: [],
      openRunsClosed: 0
    })
  })
})
