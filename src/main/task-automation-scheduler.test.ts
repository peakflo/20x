import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeTask } from '../../test/helpers/task-fixtures'
import { TaskAutomationScheduler } from './task-automation-scheduler'
import { TaskStatus } from '../shared/constants'
import type { DatabaseManager } from './database'
import type { AgentManager } from './agent-manager'

/**
 * These tests run against a real in-memory SQLite database with the production
 * schema, so the scheduler's SQL (including the recurring-template exclusion
 * and the boolean column encoding) is genuinely exercised rather than mocked.
 */

let db: DatabaseManager

function mockAgentManager(overrides: Record<string, unknown> = {}): AgentManager {
  return {
    startTask: vi.fn().mockResolvedValue({ action: 'task_started', startedTaskId: 'x' }),
    completeTaskWithoutReview: vi.fn().mockResolvedValue(true),
    hasActiveSessionForTask: vi.fn().mockReturnValue(false),
    ...overrides
  } as unknown as AgentManager
}

beforeEach(() => {
  ;({ db } = createTestDb())
})

// ── Auto-start ──────────────────────────────────────────────

describe('TaskAutomationScheduler — auto-start', () => {
  it('starts a not_started task flagged auto_start_agent', async () => {
    const task = db.createTask(makeTask({ auto_start_agent: true }))!
    const agentManager = mockAgentManager()

    await new TaskAutomationScheduler(db, agentManager).runNow()

    expect(agentManager.startTask).toHaveBeenCalledWith(task.id)
  })

  it('leaves a task without the flag alone', async () => {
    db.createTask(makeTask({ auto_start_agent: false }))
    const agentManager = mockAgentManager()

    await new TaskAutomationScheduler(db, agentManager).runNow()

    expect(agentManager.startTask).not.toHaveBeenCalled()
  })

  it('never starts a recurring template — a template is a schedule, not work', async () => {
    db.createTask(
      makeTask({
        auto_start_agent: true,
        is_recurring: true,
        recurrence_pattern: '0 9 * * *'
      })
    )
    const agentManager = mockAgentManager()

    await new TaskAutomationScheduler(db, agentManager).runNow()

    expect(agentManager.startTask).not.toHaveBeenCalled()
  })

  it('starts the instance of a recurring template', async () => {
    const template = db.createTask(
      makeTask({ auto_start_agent: true, is_recurring: true, recurrence_pattern: '0 9 * * *' })
    )!
    const instance = db.createTask(
      makeTask({ auto_start_agent: true, recurrence_parent_id: template.id })
    )!
    const agentManager = mockAgentManager()

    await new TaskAutomationScheduler(db, agentManager).runNow()

    expect(agentManager.startTask).toHaveBeenCalledTimes(1)
    expect(agentManager.startTask).toHaveBeenCalledWith(instance.id)
  })

  it('starts EVERY pending instance, not just the first — the bug that stalled recurring tasks', async () => {
    const ids = [1, 2, 3].map(
      (n) => db.createTask(makeTask({ title: `Run ${n}`, auto_start_agent: true }))!.id
    )
    const agentManager = mockAgentManager()

    await new TaskAutomationScheduler(db, agentManager).runNow()

    const started = (agentManager.startTask as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(started).toEqual(ids)
  })

  it('skips a task that already has a live agent session', async () => {
    db.createTask(makeTask({ auto_start_agent: true }))
    const agentManager = mockAgentManager({ hasActiveSessionForTask: vi.fn().mockReturnValue(true) })

    await new TaskAutomationScheduler(db, agentManager).runNow()

    expect(agentManager.startTask).not.toHaveBeenCalled()
  })

  it('skips a snoozed task and starts it once the snooze has passed', async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString()
    const task = db.createTask(makeTask({ auto_start_agent: true }))!
    db.updateTask(task.id, { snoozed_until: future })
    const agentManager = mockAgentManager()
    const scheduler = new TaskAutomationScheduler(db, agentManager)

    await scheduler.runNow()
    expect(agentManager.startTask).not.toHaveBeenCalled()

    db.updateTask(task.id, { snoozed_until: new Date(Date.now() - 1000).toISOString() })
    await scheduler.runNow()
    expect(agentManager.startTask).toHaveBeenCalledWith(task.id)
  })

  it('does not re-start a task that has already moved out of not_started', async () => {
    const task = db.createTask(makeTask({ auto_start_agent: true }))!
    db.updateTask(task.id, { status: TaskStatus.AgentWorking })
    const agentManager = mockAgentManager()

    await new TaskAutomationScheduler(db, agentManager).runNow()

    expect(agentManager.startTask).not.toHaveBeenCalled()
  })

  it('gives up on a task whose start keeps throwing instead of retrying for ever', async () => {
    db.createTask(makeTask({ auto_start_agent: true }))
    const agentManager = mockAgentManager({
      startTask: vi.fn().mockRejectedValue(new Error('adapter unavailable'))
    })
    const scheduler = new TaskAutomationScheduler(db, agentManager)

    for (let i = 0; i < 6; i++) await scheduler.runNow()

    expect((agentManager.startTask as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3)
  })
})

// ── Auto-complete ───────────────────────────────────────────

describe('TaskAutomationScheduler — auto-complete', () => {
  it('completes a ready_for_review task flagged auto_complete_without_review', async () => {
    const task = db.createTask(makeTask({ auto_complete_without_review: true }))!
    db.updateTask(task.id, { status: TaskStatus.ReadyForReview })
    const agentManager = mockAgentManager()

    await new TaskAutomationScheduler(db, agentManager).runNow()

    expect(agentManager.completeTaskWithoutReview).toHaveBeenCalledWith(task.id)
  })

  it('completes a parent task that a coordinator left in review — no session, no event', async () => {
    // This is the route the renderer never covered: the parent is moved to
    // ready_for_review by subtask orchestration, not by its own agent going idle.
    const parent = db.createTask(makeTask({ auto_complete_without_review: true }))!
    db.createTask(makeTask({ parent_task_id: parent.id, status: TaskStatus.Completed }))
    db.updateTask(parent.id, { status: TaskStatus.ReadyForReview })
    const agentManager = mockAgentManager()

    await new TaskAutomationScheduler(db, agentManager).runNow()

    expect(agentManager.completeTaskWithoutReview).toHaveBeenCalledWith(parent.id)
  })

  it('leaves a ready_for_review task without the flag for a human', async () => {
    const task = db.createTask(makeTask({ auto_complete_without_review: false }))!
    db.updateTask(task.id, { status: TaskStatus.ReadyForReview })
    const agentManager = mockAgentManager()

    await new TaskAutomationScheduler(db, agentManager).runNow()

    expect(agentManager.completeTaskWithoutReview).not.toHaveBeenCalled()
  })

  it('does not complete under a still-running agent', async () => {
    const task = db.createTask(makeTask({ auto_complete_without_review: true }))!
    db.updateTask(task.id, { status: TaskStatus.ReadyForReview })
    const agentManager = mockAgentManager({ hasActiveSessionForTask: vi.fn().mockReturnValue(true) })

    await new TaskAutomationScheduler(db, agentManager).runNow()

    expect(agentManager.completeTaskWithoutReview).not.toHaveBeenCalled()
  })

  it('stops retrying a task the source system keeps refusing to close', async () => {
    const task = db.createTask(makeTask({ auto_complete_without_review: true }))!
    db.updateTask(task.id, { status: TaskStatus.ReadyForReview })
    // completeTaskWithoutReview returning false puts the task back into review,
    // so without a cap the sweep would call the failing upstream every tick.
    const agentManager = mockAgentManager({
      completeTaskWithoutReview: vi.fn().mockResolvedValue(false)
    })
    const scheduler = new TaskAutomationScheduler(db, agentManager)

    for (let i = 0; i < 6; i++) await scheduler.runNow()

    expect((agentManager.completeTaskWithoutReview as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3)
  })

  it('ignores a task that is not in review yet', async () => {
    db.createTask(makeTask({ auto_complete_without_review: true, status: TaskStatus.AgentWorking }))
    const agentManager = mockAgentManager()

    await new TaskAutomationScheduler(db, agentManager).runNow()

    expect(agentManager.completeTaskWithoutReview).not.toHaveBeenCalled()
  })
})

// ── Lifecycle ───────────────────────────────────────────────

describe('TaskAutomationScheduler — lifecycle', () => {
  it('reconciles immediately on start, so nothing missed while closed stays stuck', async () => {
    vi.useFakeTimers()
    try {
      const task = db.createTask(makeTask({ auto_start_agent: true }))!
      const agentManager = mockAgentManager()
      const scheduler = new TaskAutomationScheduler(db, agentManager)

      scheduler.start()
      await vi.advanceTimersByTimeAsync(0)
      scheduler.stop()

      expect(agentManager.startTask).toHaveBeenCalledWith(task.id)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps sweeping on its interval', async () => {
    vi.useFakeTimers()
    try {
      const agentManager = mockAgentManager()
      const scheduler = new TaskAutomationScheduler(db, agentManager)
      scheduler.start()
      await vi.advanceTimersByTimeAsync(0)

      // A task created after start-up is picked up by a later tick
      const task = db.createTask(makeTask({ auto_start_agent: true }))!
      await vi.advanceTimersByTimeAsync(60_000)
      scheduler.stop()

      expect(agentManager.startTask).toHaveBeenCalledWith(task.id)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop() prevents any further sweeps', async () => {
    vi.useFakeTimers()
    try {
      const agentManager = mockAgentManager()
      const scheduler = new TaskAutomationScheduler(db, agentManager)
      scheduler.start()
      await vi.advanceTimersByTimeAsync(0)
      scheduler.stop()

      db.createTask(makeTask({ auto_start_agent: true }))
      await vi.advanceTimersByTimeAsync(180_000)

      expect(agentManager.startTask).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
