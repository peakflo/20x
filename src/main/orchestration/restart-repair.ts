/**
 * Repairs tasks left running when the app was last closed or crashed.
 *
 * Problem this fixes: shutdown stops in-memory sessions but leaves their
 * tasks' DB rows exactly as they were — `agent_working` or `triaging` — and
 * nothing at startup ever looked at that again. The automation scheduler then
 * treats an `agent_working` child as genuinely active forever, so a chain
 * stalls permanently the moment the app is closed mid-run.
 *
 * Call {@link runRestartRepair} once at startup, after `AgentManager` exists
 * but BEFORE the automation scheduler's first pass — a repaired task (reset
 * to `not_started`, or auto-resumed) needs to be visible to that first pass,
 * not discovered a tick later.
 */

import type { DatabaseManager } from '../database'
import { TaskStatus } from '../../shared/constants'

/** The minimal AgentManager surface restart-repair needs — kept narrow so it's trivial to fake in tests. */
export interface RestartRepairAgentManager {
  findSessionByTaskId(taskId: string): { sessionId: string } | undefined
  startTask(taskId: string, opts?: { preferSubtasks?: boolean; allowTriage?: boolean }): Promise<unknown>
  /** Native resume of a persisted session. Returns the resumed session id, or '' if native resume isn't possible (different/non-shareable harness instance, etc.) — callers must fall back to `startTask` in that case, never treat '' as success. */
  resumeSession(agentId: string, taskId: string, sessionId: string): Promise<string>
  sendByTaskId(taskId: string, message: string): Promise<unknown>
  /** Writes a status update through the server-managed guard and notifies the renderer — never poke `DatabaseManager.updateTask` directly from here. */
  applyLocalTaskUpdate(taskId: string, updates: Record<string, unknown>): unknown
  /** Flags "needs attention" (reused model_error) through the normal path: server-managed guard, renderer notify, and parent wake-up. */
  markTaskModelError(taskId: string): void
}

export interface RestartRepairSummary {
  /** agent_working, no live session, resumable (has a persisted session_id) and part of an auto chain/pending wake-up — resumed automatically (natively if possible, otherwise a fresh session with the context handed off). */
  autoResumed: string[]
  /** agent_working, no live session, resumable but not auto-resumed — left for a human "Resume" action. */
  needsResume: string[]
  /** agent_working, no live session, with no persisted session_id to resume from — left for a human, cannot auto-resume. */
  needsAttention: string[]
  /** triaging, no live session — reset to not_started so it can be triaged again. */
  triagingReset: string[]
  /** agent_working with a pending ('waiting') usage-limit recovery row — left entirely alone for the dedicated usage-limit-recovery sweep, which already owns resuming it when the limit resets. */
  skippedUsageLimited: string[]
  /** task_runs rows left open from the previous run, closed with end_reason='interrupted'. */
  openRunsClosed: number
}

interface CandidateRow {
  id: string
  status: string
}

function hasPendingWakeupAsParent(db: DatabaseManager, taskId: string): boolean {
  try {
    const row = db.db
      .prepare(`SELECT 1 FROM task_wakeups WHERE parent_task_id = ? AND delivered_at IS NULL AND given_up_at IS NULL LIMIT 1`)
      .get(taskId)
    return !!row
  } catch {
    // table doesn't exist yet (no wake-up has ever been enqueued this app lifetime) — nothing pending.
    return false
  }
}

/**
 * True when `usage_limit_recoveries` (see usage/usage-limit-recovery.ts) has
 * a `status = 'waiting'` row for this task — a usage-limit stop leaves the
 * task `agent_working` by design, with its OWN dedicated recovery flow that
 * resumes it once the limit resets. Restart repair must leave these
 * completely alone: marking one "interrupted" or (worse) starting a session
 * straight into a still-active limit, while the limit-recovery sweep ALSO
 * continues it once ready, produces two runs for one task.
 */
function hasWaitingUsageLimitRecovery(db: DatabaseManager, taskId: string): boolean {
  try {
    const row = db.db
      .prepare(`SELECT 1 FROM usage_limit_recoveries WHERE task_id = ? AND status = 'waiting' LIMIT 1`)
      .get(taskId)
    return !!row
  } catch {
    // table doesn't exist yet (no usage-limit stop has ever been recorded this app lifetime).
    return false
  }
}

function appendRepairNote(db: DatabaseManager, taskId: string, note: string, nowMs: number): void {
  try {
    db.upsertTranscriptParts(taskId, [
      {
        id: `restart-repair-${taskId}-${nowMs}`,
        role: 'system',
        content: note,
        partType: 'text',
        receivedAt: nowMs
      }
    ])
  } catch (err) {
    console.error(`[RestartRepair] Failed to write transcript note for ${taskId}:`, err)
  }
}

/**
 * Finds every `agent_working`/`triaging` task with no live session (true for
 * all of them right after a cold start, since every session dies with the
 * process) and repairs it:
 *
 * - A pending ('waiting') usage-limit recovery → skipped entirely; that flow
 *   owns this task until the limit resets.
 * - `triaging` → reset to `not_started` so it triages again from scratch.
 * - `agent_working` with a persisted `session_id` (native resume is
 *   possible) and either `auto_start_agent` or a pending parent wake-up
 *   waiting on it → resumed: natively via `resumeSession` + a short
 *   "continue after restart" nudge when the saved session can be resumed,
 *   falling back to `startTask` (a fresh session with the context handed
 *   off) only when native resume isn't possible.
 * - `agent_working` with a persisted `session_id` but not part of an auto
 *   chain → left for a human "Resume" action.
 * - `agent_working` with no persisted `session_id` → left "needs attention";
 *   nothing can resume it automatically.
 *
 * Every repaired task gets a transcript note explaining what happened — not
 * a silent status flip. Every status write goes through
 * `AgentManager.applyLocalTaskUpdate`/`markTaskModelError` (the same
 * server-managed guard + renderer notification every other local-agent
 * status write uses), never `DatabaseManager.updateTask` directly. Every
 * "needs attention" case also reuses `model_error` (see run-finalization.ts)
 * rather than inventing a new status value, so no consumer (filters,
 * mobile, sync) needs updating.
 */
export async function runRestartRepair(
  db: DatabaseManager,
  agentManager: RestartRepairAgentManager,
  nowMs: number = Date.now()
): Promise<RestartRepairSummary> {
  const summary: RestartRepairSummary = {
    autoResumed: [],
    needsResume: [],
    needsAttention: [],
    triagingReset: [],
    skippedUsageLimited: [],
    openRunsClosed: 0
  }

  for (const run of db.getOpenTaskRuns()) {
    db.closeTaskRun(run.sessionId, nowMs, 'interrupted')
    summary.openRunsClosed++
  }

  const candidates = db.db
    .prepare(`SELECT id, status FROM tasks WHERE status IN (?, ?)`)
    .all(TaskStatus.AgentWorking, TaskStatus.Triaging) as CandidateRow[]

  for (const candidate of candidates) {
    // A genuinely live session for this task id means it isn't actually
    // stuck (shouldn't happen at cold boot, but never clobber real work).
    if (agentManager.findSessionByTaskId(candidate.id)) continue

    if (candidate.status === TaskStatus.Triaging) {
      agentManager.applyLocalTaskUpdate(candidate.id, { status: TaskStatus.NotStarted })
      appendRepairNote(db, candidate.id, 'Triage was interrupted by a restart — reset to not started so it can be triaged again.', nowMs)
      summary.triagingReset.push(candidate.id)
      continue
    }

    // A usage-limit stop leaves the task agent_working by design, with its
    // own dedicated recovery flow — never touch it here.
    if (hasWaitingUsageLimitRecovery(db, candidate.id)) {
      summary.skippedUsageLimited.push(candidate.id)
      continue
    }

    const task = db.getTask(candidate.id)
    if (!task) continue

    const resumable = !!task.session_id
    const partOfAutoChain = task.auto_start_agent || hasPendingWakeupAsParent(db, candidate.id)

    if (resumable && partOfAutoChain) {
      try {
        const resumedSessionId = task.agent_id
          ? await agentManager.resumeSession(task.agent_id, candidate.id, task.session_id!)
          : ''
        if (resumedSessionId) {
          // Native resume succeeded — nudge the SAME session to continue
          // instead of re-sending the original prompt into a brand-new one.
          await agentManager.sendByTaskId(candidate.id, 'Continuing — the app restarted while this task was running.')
          appendRepairNote(db, candidate.id, 'Interrupted by restart — resumed automatically (same session) because this task is part of an auto-run chain.', nowMs)
        } else {
          // Native resume isn't possible (e.g. a different/non-shareable
          // harness instance) — fall back to a fresh session, which carries
          // the context handoff, same as any other cross-harness resume.
          await agentManager.startTask(candidate.id, { preferSubtasks: false, allowTriage: false })
          appendRepairNote(db, candidate.id, 'Interrupted by restart — the saved session could not be resumed natively, so a new session continued with the context handed off, because this task is part of an auto-run chain.', nowMs)
        }
        summary.autoResumed.push(candidate.id)
        continue
      } catch (err) {
        console.error(`[RestartRepair] Auto-resume failed for ${candidate.id}, leaving for manual resume:`, err)
        // fall through to the manual-resume branch below
      }
    }

    agentManager.markTaskModelError(candidate.id)
    if (resumable) {
      appendRepairNote(db, candidate.id, 'Interrupted by restart — the app closed while this was running. Resume to continue.', nowMs)
      summary.needsResume.push(candidate.id)
    } else {
      appendRepairNote(db, candidate.id, 'Interrupted by restart — no saved session to resume from. This needs attention.', nowMs)
      summary.needsAttention.push(candidate.id)
    }
  }

  return summary
}
