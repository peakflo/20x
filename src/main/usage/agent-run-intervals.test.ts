import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { makeTask } from '../../../test/helpers/task-fixtures'
import { TaskStatus } from '../../shared/constants'
import type { UsageProvider } from '../../shared/usage'
import type { DatabaseManager } from '../database'
import {
  recordAgentStatusTransition,
  closeSessionIntervalOnDestroy,
  renameSessionOnRekey,
  recoverCrashedIntervals,
  runAgentRunIntervalBackfill,
  isExcludedAgentRunTask,
  isAgentSessionStatus,
  BACKFILL_SETTING_KEY,
  type AgentRunContext
} from './agent-run-intervals'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0)

let db: DatabaseManager

function ctx(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    taskId: 'task-1',
    agentId: 'agent-1',
    sessionId: 'session-1',
    provider: 'claude-code',
    harnessInstanceId: null,
    isTriageSession: false,
    taskStatus: TaskStatus.AgentWorking,
    ...overrides
  }
}

beforeEach(() => {
  ;({ db } = createTestDb())
  // Touch the lazily-created usage schema before any raw token_usage_events inserts.
  void db.usage
})

describe('isExcludedAgentRunTask', () => {
  it('excludes the mastermind pseudo-session', () => {
    expect(isExcludedAgentRunTask('mastermind-session', false, TaskStatus.AgentWorking)).toBe(true)
  })
  it('excludes heartbeat wake-ups', () => {
    expect(isExcludedAgentRunTask('heartbeat-task-1', false, TaskStatus.AgentWorking)).toBe(true)
  })
  it('excludes triage sessions', () => {
    expect(isExcludedAgentRunTask('task-1', true, TaskStatus.AgentWorking)).toBe(true)
  })
  it('excludes learn-from-session runs (task status AgentLearning)', () => {
    expect(isExcludedAgentRunTask('task-1', false, TaskStatus.AgentLearning)).toBe(true)
  })
  it('does not exclude ordinary work', () => {
    expect(isExcludedAgentRunTask('task-1', false, TaskStatus.AgentWorking)).toBe(false)
  })
})

describe('isAgentSessionStatus', () => {
  it('accepts the four known statuses and rejects anything else', () => {
    expect(isAgentSessionStatus('working')).toBe(true)
    expect(isAgentSessionStatus('idle')).toBe(true)
    expect(isAgentSessionStatus('error')).toBe(true)
    expect(isAgentSessionStatus('waiting_approval')).toBe(true)
    expect(isAgentSessionStatus('something_else')).toBe(false)
  })
})

describe('recordAgentStatusTransition', () => {
  it('opens an interval when a brand-new session becomes working (prevStatus undefined)', () => {
    recordAgentStatusTransition(db, ctx(), undefined, 'working', BASE)
    const open = db.getOpenAgentRunIntervalForSession('session-1')
    expect(open).toBeDefined()
    expect(open!.startedAtMs).toBe(BASE)
    expect(open!.endedAtMs).toBeNull()
  })

  it('opens an interval on idle -> working', () => {
    recordAgentStatusTransition(db, ctx(), 'idle', 'working', BASE)
    expect(db.getOpenAgentRunIntervalForSession('session-1')).toBeDefined()
  })

  it('closes the open interval on working -> idle with end_reason "idle"', () => {
    recordAgentStatusTransition(db, ctx(), undefined, 'working', BASE)
    recordAgentStatusTransition(db, ctx(), 'working', 'idle', BASE + HOUR)
    expect(db.getOpenAgentRunIntervalForSession('session-1')).toBeUndefined()
    const closed = db.getAgentRunIntervalsOverlapping(BASE - HOUR, BASE + 2 * HOUR)
    expect(closed).toHaveLength(1)
    expect(closed[0].endedAtMs).toBe(BASE + HOUR)
    expect(closed[0].endReason).toBe('idle')
  })

  it('closes the open interval on working -> waiting_approval and working -> error', () => {
    recordAgentStatusTransition(db, ctx({ sessionId: 's-wa' }), undefined, 'working', BASE)
    recordAgentStatusTransition(db, ctx({ sessionId: 's-wa' }), 'working', 'waiting_approval', BASE + MINUTE)
    expect(db.getOpenAgentRunIntervalForSession('s-wa')).toBeUndefined()

    recordAgentStatusTransition(db, ctx({ sessionId: 's-err' }), undefined, 'working', BASE)
    recordAgentStatusTransition(db, ctx({ sessionId: 's-err' }), 'working', 'error', BASE + MINUTE)
    expect(db.getOpenAgentRunIntervalForSession('s-err')).toBeUndefined()
  })

  it('is a no-op for a transition that does not cross the working boundary', () => {
    recordAgentStatusTransition(db, ctx(), 'idle', 'error', BASE)
    expect(db.getOpenAgentRunIntervalForSession('session-1')).toBeUndefined()
    expect(db.getAgentRunIntervalsOverlapping(BASE - HOUR, BASE + HOUR)).toHaveLength(0)
  })

  it('never opens a row for mastermind-session', () => {
    recordAgentStatusTransition(db, ctx({ taskId: 'mastermind-session' }), undefined, 'working', BASE)
    expect(db.getOpenAgentRunIntervalForSession('session-1')).toBeUndefined()
  })

  it('never opens a row for a heartbeat wake-up task', () => {
    recordAgentStatusTransition(db, ctx({ taskId: 'heartbeat-task-1' }), undefined, 'working', BASE)
    expect(db.getOpenAgentRunIntervalForSession('session-1')).toBeUndefined()
  })

  it('never opens a row for a triage session', () => {
    recordAgentStatusTransition(db, ctx({ isTriageSession: true }), undefined, 'working', BASE)
    expect(db.getOpenAgentRunIntervalForSession('session-1')).toBeUndefined()
  })

  it('never opens a row while the task is in AgentLearning (learn-from-session)', () => {
    recordAgentStatusTransition(db, ctx({ taskStatus: TaskStatus.AgentLearning }), undefined, 'working', BASE)
    expect(db.getOpenAgentRunIntervalForSession('session-1')).toBeUndefined()
  })

  it('DOES open a row for a subtask/subagent session (parent_task_id does not exclude)', () => {
    const parent = db.createTask(makeTask({ title: 'Parent' }))!
    const subtask = db.createTask(makeTask({ title: 'Subtask', parent_task_id: parent.id, status: TaskStatus.AgentWorking }))!
    recordAgentStatusTransition(
      db,
      ctx({ taskId: subtask.id, sessionId: 'subtask-session', taskStatus: TaskStatus.AgentWorking }),
      undefined,
      'working',
      BASE
    )
    const open = db.getOpenAgentRunIntervalForSession('subtask-session')
    expect(open).toBeDefined()
    expect(open!.taskId).toBe(subtask.id)
  })
})

describe('closeSessionIntervalOnDestroy', () => {
  it('closes an open interval', () => {
    recordAgentStatusTransition(db, ctx(), undefined, 'working', BASE)
    closeSessionIntervalOnDestroy(db, 'session-1', BASE + HOUR, 'stopped')
    const row = db.getAgentRunIntervalsOverlapping(BASE - HOUR, BASE + 2 * HOUR)[0]
    expect(row.endedAtMs).toBe(BASE + HOUR)
    expect(row.endReason).toBe('stopped')
  })

  it('is a harmless no-op when nothing is open (idempotent)', () => {
    expect(() => closeSessionIntervalOnDestroy(db, 'no-such-session', BASE, 'stopped')).not.toThrow()
    closeSessionIntervalOnDestroy(db, 'session-1', BASE, 'stopped')
    // Calling it again after it's already closed must not throw or change anything.
    expect(() => closeSessionIntervalOnDestroy(db, 'session-1', BASE + HOUR, 'stopped')).not.toThrow()
  })
})

describe('renameSessionOnRekey', () => {
  it('moves the open interval to the new session id', () => {
    recordAgentStatusTransition(db, ctx({ sessionId: 'temp-id' }), undefined, 'working', BASE)
    renameSessionOnRekey(db, 'temp-id', 'real-id')
    expect(db.getOpenAgentRunIntervalForSession('temp-id')).toBeUndefined()
    expect(db.getOpenAgentRunIntervalForSession('real-id')).toBeDefined()
  })
})

describe('recoverCrashedIntervals', () => {
  it('closes a stale open interval at the latest token_usage_events timestamp for that session', () => {
    recordAgentStatusTransition(db, ctx({ sessionId: 'crash-1' }), undefined, 'working', BASE)
    insertUsageEvent({ sessionId: 'crash-1', taskId: 'task-1', agentId: 'agent-1', createdAt: BASE + 30 * MINUTE })
    insertUsageEvent({ sessionId: 'crash-1', taskId: 'task-1', agentId: 'agent-1', createdAt: BASE + 45 * MINUTE })

    const result = recoverCrashedIntervals(db, () => false, BASE + 2 * HOUR)
    expect(result.recovered).toBe(1)
    const row = db.getAgentRunIntervalsOverlapping(BASE - HOUR, BASE + 2 * HOUR).find((r) => r.sessionId === 'crash-1')!
    expect(row.endedAtMs).toBe(BASE + 45 * MINUTE)
    expect(row.endReason).toBe('crash_recovered')
  })

  it('falls back to the latest transcript_parts activity for the task when there is no usage event', () => {
    recordAgentStatusTransition(db, ctx({ sessionId: 'crash-2' }), undefined, 'working', BASE)
    db.upsertTranscriptParts('task-1', [{ id: 'p1', content: 'hi', receivedAt: BASE + 20 * MINUTE }])

    const result = recoverCrashedIntervals(db, () => false, BASE + 2 * HOUR)
    expect(result.recovered).toBe(1)
    const row = db.getAgentRunIntervalsOverlapping(BASE - HOUR, BASE + 2 * HOUR).find((r) => r.sessionId === 'crash-2')!
    expect(row.endedAtMs).toBe(BASE + 20 * MINUTE)
  })

  it('falls back to the interval start time when there is no activity signal at all', () => {
    recordAgentStatusTransition(db, ctx({ sessionId: 'crash-3' }), undefined, 'working', BASE)
    const result = recoverCrashedIntervals(db, () => false, BASE + 2 * HOUR)
    expect(result.recovered).toBe(1)
    const row = db.getAgentRunIntervalsOverlapping(BASE - HOUR, BASE + 2 * HOUR).find((r) => r.sessionId === 'crash-3')!
    expect(row.endedAtMs).toBe(BASE)
  })

  it('leaves a session alone when isSessionActive reports it is still running', () => {
    recordAgentStatusTransition(db, ctx({ sessionId: 'still-alive' }), undefined, 'working', BASE)
    const result = recoverCrashedIntervals(db, (sessionId) => sessionId === 'still-alive', BASE + HOUR)
    expect(result.skippedStillActive).toBe(1)
    expect(db.getOpenAgentRunIntervalForSession('still-alive')).toBeDefined()
  })

  it('is idempotent: a second run finds nothing left open', () => {
    recordAgentStatusTransition(db, ctx({ sessionId: 'crash-4' }), undefined, 'working', BASE)
    const first = recoverCrashedIntervals(db, () => false, BASE + HOUR)
    expect(first.recovered).toBe(1)
    const second = recoverCrashedIntervals(db, () => false, BASE + 2 * HOUR)
    expect(second.recovered).toBe(0)
  })
})

describe('runAgentRunIntervalBackfill', () => {
  it('merges activity within the 5-minute gap into a single interval', () => {
    insertUsageEvent({ sessionId: 'bf-1', taskId: 'task-1', agentId: 'agent-1', createdAt: BASE })
    insertUsageEvent({ sessionId: 'bf-1', taskId: 'task-1', agentId: 'agent-1', createdAt: BASE + 4 * MINUTE })
    insertUsageEvent({ sessionId: 'bf-1', taskId: 'task-1', agentId: 'agent-1', createdAt: BASE + 8 * MINUTE })

    const result = runAgentRunIntervalBackfill(db)
    expect(result.sessionsInserted).toBe(1)
    expect(result.intervalsInserted).toBe(1)

    const rows = db.getAgentRunIntervalsOverlapping(BASE - HOUR, BASE + HOUR)
    expect(rows).toHaveLength(1)
    expect(rows[0].startedAtMs).toBe(BASE)
    expect(rows[0].endedAtMs).toBe(BASE + 8 * MINUTE)
    expect(rows[0].endReason).toBe('backfilled')
  })

  it('splits into two intervals across a gap of more than 5 minutes', () => {
    insertUsageEvent({ sessionId: 'bf-2', taskId: 'task-1', agentId: 'agent-1', createdAt: BASE })
    insertUsageEvent({ sessionId: 'bf-2', taskId: 'task-1', agentId: 'agent-1', createdAt: BASE + 2 * MINUTE })
    // Gap of 5 minutes + 1s from the previous point — clearly over the merge threshold.
    const secondSpanStart = BASE + 2 * MINUTE + 5 * MINUTE + 1000
    insertUsageEvent({ sessionId: 'bf-2', taskId: 'task-1', agentId: 'agent-1', createdAt: secondSpanStart })
    insertUsageEvent({ sessionId: 'bf-2', taskId: 'task-1', agentId: 'agent-1', createdAt: secondSpanStart + 2 * MINUTE })

    const result = runAgentRunIntervalBackfill(db)
    expect(result.intervalsInserted).toBe(2)

    const rows = db
      .getAgentRunIntervalsOverlapping(BASE - HOUR, BASE + HOUR)
      .filter((r) => r.sessionId === 'bf-2')
      .sort((a, b) => a.startedAtMs - b.startedAtMs)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ startedAtMs: BASE, endedAtMs: BASE + 2 * MINUTE })
    expect(rows[1]).toMatchObject({ startedAtMs: secondSpanStart, endedAtMs: secondSpanStart + 2 * MINUTE })
  })

  it('skips a session with fewer than two activity timestamps', () => {
    insertUsageEvent({ sessionId: 'bf-thin', taskId: 'task-1', agentId: 'agent-1', createdAt: BASE })
    const result = runAgentRunIntervalBackfill(db)
    expect(result.sessionsSkipped).toBeGreaterThanOrEqual(1)
    expect(db.getAgentRunIntervalsOverlapping(BASE - HOUR, BASE + HOUR).filter((r) => r.sessionId === 'bf-thin')).toHaveLength(0)
  })

  it('skips a session whose task is currently excluded (e.g. AgentLearning)', () => {
    const task = db.createTask(makeTask({ title: 'Learning', status: TaskStatus.AgentLearning }))!
    insertUsageEvent({ sessionId: 'bf-learning', taskId: task.id, agentId: 'agent-1', createdAt: BASE })
    insertUsageEvent({ sessionId: 'bf-learning', taskId: task.id, agentId: 'agent-1', createdAt: BASE + MINUTE })

    runAgentRunIntervalBackfill(db)
    expect(db.getAgentRunIntervalsOverlapping(BASE - HOUR, BASE + HOUR).filter((r) => r.sessionId === 'bf-learning')).toHaveLength(0)
  })

  it('skips a session that already has an agent_run_intervals row', () => {
    recordAgentStatusTransition(db, ctx({ sessionId: 'already-covered' }), undefined, 'working', BASE)
    recordAgentStatusTransition(db, ctx({ sessionId: 'already-covered' }), 'working', 'idle', BASE + MINUTE)
    insertUsageEvent({ sessionId: 'already-covered', taskId: 'task-1', agentId: 'agent-1', createdAt: BASE + 10 * HOUR })
    insertUsageEvent({ sessionId: 'already-covered', taskId: 'task-1', agentId: 'agent-1', createdAt: BASE + 11 * HOUR })

    runAgentRunIntervalBackfill(db)
    const rows = db.getAgentRunIntervalsOverlapping(BASE - HOUR, BASE + 24 * HOUR).filter((r) => r.sessionId === 'already-covered')
    // Only the one live-recorded row — backfill must not add a second, overlapping one.
    expect(rows).toHaveLength(1)
    expect(rows[0].endReason).toBe('idle')
  })

  it('is idempotent: running it twice inserts nothing the second time and leaves no duplicates', () => {
    insertUsageEvent({ sessionId: 'bf-idem', taskId: 'task-1', agentId: 'agent-1', createdAt: BASE })
    insertUsageEvent({ sessionId: 'bf-idem', taskId: 'task-1', agentId: 'agent-1', createdAt: BASE + 2 * MINUTE })

    const first = runAgentRunIntervalBackfill(db)
    expect(first.intervalsInserted).toBe(1)

    const second = runAgentRunIntervalBackfill(db)
    expect(second.intervalsInserted).toBe(0)
    expect(second.sessionsInserted).toBe(0)

    expect(db.getSetting(BACKFILL_SETTING_KEY)).toBeTruthy()
    const rows = db.getAgentRunIntervalsOverlapping(BASE - HOUR, BASE + HOUR).filter((r) => r.sessionId === 'bf-idem')
    expect(rows).toHaveLength(1)
  })
})

// ── test helpers ─────────────────────────────────────────────

let usageEventSeq = 0

function insertUsageEvent(input: { sessionId: string; taskId: string; agentId: string; createdAt: number; provider?: string; instanceId?: string | null }): void {
  // Goes through UsageStore's public recordDiscreteUsage so the schema/columns
  // always match whatever usage-store.ts currently defines.
  db.usage.recordDiscreteUsage({
    provider: (input.provider ?? 'claude-code') as UsageProvider,
    sessionId: input.sessionId,
    taskId: input.taskId,
    agentId: input.agentId,
    instanceId: input.instanceId ?? null,
    items: [{
      sourceKey: `${input.sessionId}:${usageEventSeq++}`,
      model: 'test-model',
      usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0, costUsd: null },
      occurredAt: input.createdAt
    }]
  })
}
