/**
 * Writer side of the "my multiplier" feature: opens/closes `agent_run_intervals`
 * rows as agent sessions move in and out of the 'working' status, recovers
 * rows left open by a crash, and best-effort backfills history from before
 * this table existed.
 *
 * This module only talks to the database through `DatabaseManager` (see the
 * `agent_run_intervals` section of src/main/database.ts) — it has no
 * knowledge of `AgentSession`/adapters/polling, so it can be unit tested
 * without constructing an `AgentManager`. agent-manager.ts is the sole caller:
 * it resolves the per-session context (provider, harness instance, task,
 * triage flag) from its own in-memory state and calls into this module at
 * every status-transition and session-destroy site.
 */

import type { DatabaseManager, AgentRunIntervalRecord } from '../database'
import { TaskStatus } from '../../shared/constants'

/** The session lifecycle states recorded upstream — mirrors `AgentSession['status']` in agent-manager.ts. */
export type AgentSessionStatus = 'idle' | 'working' | 'error' | 'waiting_approval'

const AGENT_SESSION_STATUSES = new Set<string>(['idle', 'working', 'error', 'waiting_approval'])

/** Narrows an arbitrary broadcast `status` string to `AgentSessionStatus`. */
export function isAgentSessionStatus(status: string): status is AgentSessionStatus {
  return AGENT_SESSION_STATUSES.has(status)
}

/** Per-session identity needed to open/close a row. Resolved by the caller (agent-manager.ts) from its own session/agent/task state. */
export interface AgentRunContext {
  taskId: string
  agentId: string
  sessionId: string
  provider: string
  harnessInstanceId: string | null
  /** True for triage sessions — always excluded, regardless of task status. */
  isTriageSession: boolean
  /** The task's current status, used for the AgentLearning ("learn from session") exclusion. Undefined when the task record is unavailable (e.g. mastermind/heartbeat pseudo-tasks, which are already excluded by id). */
  taskStatus?: string
}

/**
 * The four kinds of session that must never get an interval row, because
 * they are not user work:
 *   - the mastermind/orchestrator pseudo-session (`taskId === 'mastermind-session'`)
 *   - heartbeat wake-up runs (`taskId.startsWith('heartbeat-')`)
 *   - triage sessions (`isTriageSession`)
 *   - learn-from-session runs (task status is `TaskStatus.AgentLearning` while these run)
 */
export function isExcludedAgentRunTask(taskId: string, isTriageSession: boolean, taskStatus: string | undefined): boolean {
  if (taskId === 'mastermind-session') return true
  if (taskId.startsWith('heartbeat-')) return true
  if (isTriageSession) return true
  if (taskStatus === TaskStatus.AgentLearning) return true
  return false
}

/**
 * Call on every `prevStatus -> nextStatus` transition (including a brand-new
 * session, where `prevStatus` is undefined). Opens a row the instant the
 * session becomes 'working' from anything else; closes the open row the
 * instant it leaves 'working'. A transition that doesn't cross the
 * 'working' boundary (e.g. waiting_approval -> error) is a no-op here —
 * nothing was open for it to begin with, since only 'working' spans get
 * rows.
 *
 * Excluded sessions are skipped entirely: no row is ever opened for them, so
 * closing is naturally also a no-op (there is nothing to close).
 */
export function recordAgentStatusTransition(
  db: DatabaseManager,
  ctx: AgentRunContext,
  prevStatus: AgentSessionStatus | undefined,
  nextStatus: AgentSessionStatus,
  atMs: number
): void {
  const wasWorking = prevStatus === 'working'
  const isWorking = nextStatus === 'working'
  if (wasWorking === isWorking) return

  if (isWorking) {
    if (isExcludedAgentRunTask(ctx.taskId, ctx.isTriageSession, ctx.taskStatus)) return
    db.openAgentRunInterval({
      taskId: ctx.taskId,
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      provider: ctx.provider,
      harnessInstanceId: ctx.harnessInstanceId,
      startedAtMs: atMs
    })
    return
  }

  // Leaving 'working': close whatever is open. No exclusion check needed —
  // an excluded session never had a row opened, so this is a harmless no-op.
  db.closeOpenAgentRunInterval(ctx.sessionId, atMs, nextStatus)
}

/**
 * Defensive close for every session-destroy/release path (stopSession,
 * triage cleanup, learn-from-session cleanup, app shutdown). Idempotent and
 * safe to call unconditionally — a session with nothing open (already
 * closed via a status transition, or excluded) is a no-op. This exists
 * because at least one destroy path (`stopSession`) broadcasts its final
 * 'idle' status *after* deleting the session and clearing `lastSentStatus`,
 * so the status-transition hook alone cannot see that case; every destroy
 * path calls this directly instead of relying solely on the broadcast hook.
 */
export function closeSessionIntervalOnDestroy(db: DatabaseManager, sessionId: string, atMs: number, endReason: string): void {
  db.closeOpenAgentRunInterval(sessionId, atMs, endReason)
}

/**
 * Re-keys the open interval when a session's in-memory id changes (the
 * adapter reveals its "real" session id after a temp id was used to open
 * the interval). No-op if nothing is open under the old id.
 */
export function renameSessionOnRekey(db: DatabaseManager, oldSessionId: string, newSessionId: string): void {
  db.renameOpenAgentRunIntervalSession(oldSessionId, newSessionId)
}

// ── Crash recovery ───────────────────────────────────────────

export interface CrashRecoveryResult {
  recovered: number
  skippedStillActive: number
}

/**
 * Closes every interval left open by a previous run that crashed (or was
 * force-quit) before it could close its own rows. Must run synchronously (or
 * be awaited) before anything queries `agent_run_intervals`, and is
 * idempotent — a second run finds nothing left open and does nothing.
 *
 * `isSessionActive` lets the caller (agent-manager.ts) report any session
 * that is, against expectation, still genuinely running (e.g. a hot reload
 * in development) — those are left open rather than being cut short. In the
 * normal cold-start case every row this finds predates the current process,
 * so the predicate returns false for everything.
 *
 * Close time is the best available "last known activity" signal, in order:
 * the latest `token_usage_events` row for that session (exact — this table
 * has a real session_id column), else the latest `transcript_parts` row for
 * that task (approximate — transcript_parts has no session_id column, so
 * this is scoped to task_id only), else the interval's own start time.
 * Never left open for days.
 */
export function recoverCrashedIntervals(
  db: DatabaseManager,
  isSessionActive: (sessionId: string) => boolean,
  nowMs: number
): CrashRecoveryResult {
  const open = db.getOpenAgentRunIntervals()
  let recovered = 0
  let skippedStillActive = 0

  for (const interval of open) {
    if (isSessionActive(interval.sessionId)) {
      skippedStillActive++
      continue
    }

    const lastActivityMs = resolveLastKnownActivity(db, interval)
    const closeAtMs = Math.min(Math.max(lastActivityMs, interval.startedAtMs), nowMs)
    db.closeOpenAgentRunInterval(interval.sessionId, closeAtMs, 'crash_recovered')
    recovered++
  }

  return { recovered, skippedStillActive }
}

function resolveLastKnownActivity(db: DatabaseManager, interval: AgentRunIntervalRecord): number {
  const fromUsageEvents = db.usage.getLatestEventAtForSession(interval.sessionId, interval.startedAtMs)
  if (fromUsageEvents !== null) return fromUsageEvents

  const fromTranscript = db.getLatestTranscriptActivityAfter(interval.taskId, interval.startedAtMs)
  if (fromTranscript !== null) return fromTranscript

  return interval.startedAtMs
}

// ── Backfill ─────────────────────────────────────────────────

/** Settings key guarding the one-time backfill job so it never re-runs. */
export const BACKFILL_SETTING_KEY = 'agent_run_intervals_backfill_v1_done'

/** Consecutive activity within this gap merges into one interval; a larger gap starts a new one. */
const BACKFILL_MERGE_GAP_MS = 5 * 60 * 1000

export interface BackfillResult {
  sessionsInserted: number
  intervalsInserted: number
  sessionsSkipped: number
}

/**
 * One-time, idempotent, best-effort derivation of historical run intervals
 * from `token_usage_events` (has real per-session timestamps) for any
 * session that doesn't already have an `agent_run_intervals` row. Guarded by
 * `BACKFILL_SETTING_KEY` so it only ever does real work once; safe to call
 * on every startup after that (it becomes a cheap settings-flag check).
 *
 * Deliberately does NOT fall back to transcript_parts: that table has no
 * session_id column, so attributing its task-scoped timestamps to a
 * specific historical session would be a guess whenever a task had more
 * than one session over its life. Per the "skip rather than guess" rule,
 * backfill only uses the one source with real per-session granularity. A
 * session with too little usage-event data to form a sane interval (fewer
 * than 2 timestamps) is skipped — a single point in time cannot be turned
 * into a duration without guessing one.
 *
 * Exclusions mirror live recording (mastermind/heartbeat/triage/learning),
 * approximated against the task's *current* status/id since historical
 * per-run state isn't preserved. "Triage" is approximated as: the task's
 * agent_id is unset (mirrors `isTriageSessionTask`'s own fallback signal).
 */
export function runAgentRunIntervalBackfill(db: DatabaseManager): BackfillResult {
  const result: BackfillResult = { sessionsInserted: 0, intervalsInserted: 0, sessionsSkipped: 0 }
  if (db.getSetting(BACKFILL_SETTING_KEY)) return result

  const alreadyCovered = db.getSessionIdsWithAgentRunIntervals()
  const events = db.usage.getUsageEventActivityForBackfill()

  let i = 0
  while (i < events.length) {
    const sessionId = events[i].sessionId
    const group: typeof events = []
    while (i < events.length && events[i].sessionId === sessionId) {
      group.push(events[i])
      i++
    }

    if (alreadyCovered.has(sessionId)) continue
    if (group.length < 2) {
      result.sessionsSkipped++
      continue
    }

    const taskId = group.find((e) => e.taskId)?.taskId ?? null
    const agentId = group.find((e) => e.agentId)?.agentId ?? null
    if (!taskId || !agentId) {
      // No task/agent to attribute the interval to — too ambiguous to keep.
      result.sessionsSkipped++
      continue
    }

    const task = db.getTask(taskId)
    const isTriageApprox = !!task && !task.agent_id
    if (isExcludedAgentRunTask(taskId, isTriageApprox, task?.status)) {
      result.sessionsSkipped++
      continue
    }

    const provider = group[0].provider
    const harnessInstanceId = group.find((e) => e.instanceId)?.instanceId ?? null

    // Merge consecutive activity into spans, splitting on gaps >= 5 minutes.
    let spanStart = group[0].createdAt
    let spanEnd = group[0].createdAt
    let inserted = 0
    for (let j = 1; j < group.length; j++) {
      const t = group[j].createdAt
      if (t - spanEnd <= BACKFILL_MERGE_GAP_MS) {
        spanEnd = t
        continue
      }
      if (spanEnd > spanStart) {
        db.insertClosedAgentRunInterval({
          taskId, agentId, sessionId, provider, harnessInstanceId,
          startedAtMs: spanStart, endedAtMs: spanEnd, endReason: 'backfilled'
        })
        inserted++
      }
      spanStart = t
      spanEnd = t
    }
    if (spanEnd > spanStart) {
      db.insertClosedAgentRunInterval({
        taskId, agentId, sessionId, provider, harnessInstanceId,
        startedAtMs: spanStart, endedAtMs: spanEnd, endReason: 'backfilled'
      })
      inserted++
    }

    if (inserted > 0) {
      result.sessionsInserted++
      result.intervalsInserted += inserted
    } else {
      // Every activity timestamp for this session was a single instant with
      // no duration at all (all events at the exact same ms) — too thin to
      // approximate a run length from.
      result.sessionsSkipped++
    }
  }

  db.setSetting(BACKFILL_SETTING_KEY, 'true')
  return result
}
