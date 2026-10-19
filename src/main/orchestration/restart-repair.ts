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
}

export interface RestartRepairSummary {
  /** agent_working, no live session, resumable (has a persisted session_id) and part of an auto chain/pending wake-up — resumed automatically. */
  autoResumed: string[]
  /** agent_working, no live session, resumable but not auto-resumed — left for a human "Resume" action. */
  needsResume: string[]
  /** agent_working, no live session, with no persisted session_id to resume from — left for a human, cannot auto-resume. */
  needsAttention: string[]
  /** triaging, no live session — reset to not_started so it can be triaged again. */
  triagingReset: string[]
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
      .prepare(`SELECT 1 FROM task_wakeups WHERE parent_task_id = ? AND delivered_at IS NULL LIMIT 1`)
      .get(taskId)
    return !!row
  } catch {
    // table doesn't exist yet (no wake-up has ever been enqueued this app lifetime) — nothing pending.
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
 * - `triaging` → reset to `not_started` so it triages again from scratch.
 * - `agent_working` with a persisted `session_id` (native resume is
 *   possible) and either `auto_start_agent` or a pending parent wake-up
 *   waiting on it → resumed automatically via `startTask`.
 * - `agent_working` with a persisted `session_id` but not part of an auto
 *   chain → left for a human "Resume" action.
 * - `agent_working` with no persisted `session_id` → left "needs attention";
 *   nothing can resume it automatically.
 *
 * Every repaired task gets a transcript note explaining what happened — not
 * a silent status flip. Every one also reuses `model_error` as the "needs
 * attention" status (see run-finalization.ts) rather than inventing a new
 * status value, so no consumer (filters, mobile, sync) needs updating.
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
      db.updateTask(candidate.id, { status: TaskStatus.NotStarted })
      appendRepairNote(db, candidate.id, 'Triage was interrupted by a restart — reset to not started so it can be triaged again.', nowMs)
      summary.triagingReset.push(candidate.id)
      continue
    }

    const task = db.getTask(candidate.id)
    if (!task) continue

    const resumable = !!task.session_id
    const partOfAutoChain = task.auto_start_agent || hasPendingWakeupAsParent(db, candidate.id)

    if (resumable && partOfAutoChain) {
      try {
        await agentManager.startTask(candidate.id, { preferSubtasks: false, allowTriage: false })
        appendRepairNote(db, candidate.id, 'Interrupted by restart — resumed automatically because this task is part of an auto-run chain.', nowMs)
        summary.autoResumed.push(candidate.id)
        continue
      } catch (err) {
        console.error(`[RestartRepair] Auto-resume failed for ${candidate.id}, leaving for manual resume:`, err)
        // fall through to the manual-resume branch below
      }
    }

    db.updateTask(candidate.id, { status: TaskStatus.ModelError })
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
