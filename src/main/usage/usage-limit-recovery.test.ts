import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import {
  MAX_CONSECUTIVE_AUTO_RESUMES,
  RESET_GRACE_MS,
  UsageLimitRecoveryScheduler,
  UsageLimitRecoveryStore,
  type RecoveryTaskState
} from './usage-limit-recovery'
import { exhaustedWindowsResetAt, latestResetAt } from './usage-normalize'
import type { UsageLimitRecovery } from '../../shared/usage-limit-recovery'

const HOUR = 60 * 60 * 1000
let now = Date.UTC(2026, 9, 5, 12, 0, 0)
let store: UsageLimitRecoveryStore
let taskState: RecoveryTaskState
let autoResume: boolean
let resume: ReturnType<typeof vi.fn<(recovery: UsageLimitRecovery) => Promise<void>>>
let emitted: UsageLimitRecovery[]
let scheduler: UsageLimitRecoveryScheduler

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

beforeEach(() => {
  now = Date.UTC(2026, 9, 5, 12, 0, 0)
  store = new UsageLimitRecoveryStore(new Database(':memory:'))
  taskState = { exists: true, completed: false, agentId: 'agent-1', busy: false }
  autoResume = true
  resume = vi.fn(async (_recovery: UsageLimitRecovery) => undefined)
  emitted = []
  scheduler = new UsageLimitRecoveryScheduler({
    store,
    autoResumeEnabled: () => autoResume,
    getTaskState: () => taskState,
    resume,
    emit: (recovery) => emitted.push(recovery),
    now: () => now
  })
})

function stop(resetAt: string | null) {
  return scheduler.recordStop({ taskId: 'task-1', agentId: 'agent-1', provider: 'claude-code', sessionId: 's1', resetAt, message: 'limit' })
}

describe('UsageLimitRecoveryScheduler', () => {
  it('continues once the reset time (plus grace) has passed — exactly once', async () => {
    const recovery = stop(iso(now + 2 * HOUR))
    expect(recovery).toMatchObject({ status: 'waiting', autoResume: true, resetAt: iso(now + 2 * HOUR) })

    await scheduler.sweep()
    expect(resume).not.toHaveBeenCalled()

    now += 2 * HOUR + RESET_GRACE_MS + 1
    await scheduler.sweep()
    await scheduler.sweep()
    expect(resume).toHaveBeenCalledTimes(1)
    expect(scheduler.get('task-1')).toMatchObject({ status: 'resumed', resumedAt: now })
    expect(emitted.map((r) => r.status)).toEqual(['waiting', 'resumed'])
  })

  it('survives a restart: a new scheduler on the same store runs overdue continuations', async () => {
    stop(iso(now + HOUR))
    now += 3 * HOUR
    const restarted = new UsageLimitRecoveryScheduler({
      store, autoResumeEnabled: () => true, getTaskState: () => taskState, resume, emit: () => undefined, now: () => now
    })
    await restarted.sweep()
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('never auto-continues without a known reset time, but picks one up from fresh plan windows', async () => {
    stop(null)
    now += 10 * HOUR
    await scheduler.sweep()
    expect(resume).not.toHaveBeenCalled()

    scheduler.applyLimits({
      provider: 'claude-code',
      checkedAt: iso(now),
      windows: [
        { id: 'five_hour', kind: 'session', label: '5-hour', usedPercent: 100, resetsAt: iso(now + HOUR) },
        { id: 'seven_day', kind: 'weekly', label: 'Weekly', usedPercent: 40, resetsAt: iso(now + 50 * HOUR) }
      ]
    })
    expect(scheduler.get('task-1')?.resetAt).toBe(iso(now + HOUR))
    now += HOUR + RESET_GRACE_MS + 1
    await scheduler.sweep()
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('treats a reset time that is not after the stop as unknown', () => {
    expect(stop(iso(now - 1000)).resetAt).toBeNull()
  })

  it('respects the setting and the per-task toggle', async () => {
    autoResume = false
    expect(stop(iso(now + HOUR)).autoResume).toBe(false)
    now += 2 * HOUR
    await scheduler.sweep()
    expect(resume).not.toHaveBeenCalled()

    scheduler.setAutoResume('task-1', true)
    await scheduler.sweep()
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('is superseded by a user message', async () => {
    stop(iso(now + HOUR))
    scheduler.supersede('task-1')
    now += 2 * HOUR
    await scheduler.sweep()
    expect(resume).not.toHaveBeenCalled()
    expect(scheduler.get('task-1')?.status).toBe('superseded')
  })

  it('applies task guards: completed, reassigned, deleted, busy', async () => {
    stop(iso(now + HOUR))
    now += 2 * HOUR

    taskState = { ...taskState, busy: true }
    await scheduler.sweep()
    expect(resume).not.toHaveBeenCalled()
    expect(scheduler.get('task-1')?.status).toBe('waiting')

    taskState = { ...taskState, busy: false, agentId: 'agent-2' }
    await scheduler.sweep()
    expect(scheduler.get('task-1')?.status).toBe('superseded')

    stop(iso(now + HOUR))
    now += 2 * HOUR
    taskState = { exists: true, completed: true, agentId: 'agent-1', busy: false }
    await scheduler.sweep()
    expect(scheduler.get('task-1')?.status).toBe('superseded')

    stop(iso(now + HOUR))
    now += 2 * HOUR
    taskState = { exists: false, completed: false, agentId: null, busy: false }
    await scheduler.sweep()
    expect(scheduler.get('task-1')).toBeNull()
    expect(resume).not.toHaveBeenCalled()
  })

  it('stops auto-continuing after repeated limit hits in a row', async () => {
    for (let i = 0; i < MAX_CONSECUTIVE_AUTO_RESUMES; i++) {
      expect(stop(iso(now + HOUR)).autoResume).toBe(true)
      now += HOUR + RESET_GRACE_MS + 1
      await scheduler.sweep()
    }
    expect(resume).toHaveBeenCalledTimes(MAX_CONSECUTIVE_AUTO_RESUMES)
    const capped = stop(iso(now + HOUR))
    expect(capped).toMatchObject({ autoResume: false, attempts: MAX_CONSECUTIVE_AUTO_RESUMES })
  })

  it('records a failed continuation', async () => {
    resume.mockRejectedValueOnce(new Error('agent not available'))
    stop(iso(now + HOUR))
    now += 2 * HOUR
    await scheduler.sweep()
    expect(scheduler.get('task-1')).toMatchObject({ status: 'failed', error: 'agent not available' })
  })
})

describe('reset-time helpers', () => {
  it('uses the latest reset among blocking windows, and only when all are known', () => {
    expect(latestResetAt(['2026-10-05T13:00:00Z', '2026-10-05T15:00:00Z'])).toBe('2026-10-05T15:00:00.000Z')
    expect(latestResetAt(['2026-10-05T13:00:00Z', null])).toBeNull()
    expect(latestResetAt([])).toBeNull()
  })

  it('only considers exhausted windows', () => {
    expect(exhaustedWindowsResetAt([
      { id: 'primary', kind: 'session', label: '5-hour', usedPercent: 100, resetsAt: '2026-10-05T13:00:00Z' },
      { id: 'secondary', kind: 'weekly', label: 'Weekly', usedPercent: 70, resetsAt: '2026-10-09T00:00:00Z' }
    ])).toBe('2026-10-05T13:00:00.000Z')
    expect(exhaustedWindowsResetAt([{ id: 'p', kind: 'session', label: '', usedPercent: 50, resetsAt: '2026-10-05T13:00:00Z' }])).toBeNull()
  })
})
