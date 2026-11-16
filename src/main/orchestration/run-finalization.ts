/**
 * Honest run-end classification.
 *
 * Problem this replaces: every "working → idle" transition set the task to
 * `ready_for_review`, whether the agent actually finished with a final answer
 * or merely stopped producing output — an agent that went idle right after a
 * tool call (e.g. "git commit") looked identical to one that reported real
 * results. A `model_error`, a usage-limit stop, an explicit user stop, and a
 * restart that killed the session mid-turn were each handled by their own ad
 * hoc code path, with no single, honest record of how a run actually ended.
 *
 * This module is the classifier only. The actual `task_runs` row lifecycle
 * (open on send, close on end) lives in `DatabaseManager.openTaskRun` /
 * `closeTaskRun` (see database.ts) — call sites are in agent-manager.ts, at
 * every place a run can end: idle, model_error, a usage-limit stop, an
 * explicit user stop, and (after a restart) restart-repair.ts.
 */

import { TaskStatus } from '../../shared/constants'

/** How one agent run actually ended. */
export type RunEndReason = 'completed' | 'stopped_early' | 'error' | 'interrupted' | 'limit' | 'user_stop' | 'awaiting_input'

export interface IdleEndSignal {
  /** Role of the last MEANINGFUL transcript part seen since the run started (reset on every send). */
  lastPartRole?: string | null
  /** Part type of the last meaningful transcript part seen since the run started. */
  lastPartType?: string | null
}

/**
 * Part types that are never the true end of a turn — step/progress markers
 * and other ephemera an adapter can legitimately emit AFTER the real final
 * answer. Every OpenCode assistant turn, for example, ends with a
 * `step-finish` part, so treating "the literal last part in the batch" as
 * the end signal makes every OpenCode completion misclassify as
 * `stopped_early`. See `lastMeaningfulPart`, which callers use to skip these
 * before recording what the "last part" actually was.
 *
 * - `step-start` / `step-finish` / `patch` / `snapshot` / `agent` / `retry` /
 *   `compaction` — OpenCode SDK part types passed through largely unmapped.
 * - `task_progress` / `system-status` — Claude subagent-task and
 *   system-status notices, pushed with no stable role.
 * - `todowrite` — a plan/checklist update (ACP `session/update` of kind
 *   `plan`, mapped into the existing todo convention). A turn routinely
 *   updates its plan right alongside or after the real final answer, so
 *   treating it as the "last part" misclassifies the completion underneath
 *   as stopped_early.
 */
const EPHEMERAL_PART_TYPES: ReadonlySet<string> = new Set([
  'step-start',
  'step-finish',
  'patch',
  'snapshot',
  'agent',
  'retry',
  'compaction',
  'task_progress',
  'system-status',
  'todowrite'
])

export interface MeaningfulPartCandidate {
  role?: string
  partType?: string
}

/**
 * The last part in a batch that actually represents something the agent
 * did, skipping ephemeral/meta markers from the end backwards. Returns
 * `undefined` when every part in the batch is ephemeral — callers should
 * then leave whatever was tracked from an earlier batch alone instead of
 * overwriting it with noise (the real answer may have arrived in an earlier
 * poll tick, with only trailing step-markers in this one).
 */
export function lastMeaningfulPart<T extends MeaningfulPartCandidate>(parts: readonly T[]): T | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const partType = parts[i].partType
    if (partType && EPHEMERAL_PART_TYPES.has(partType)) continue
    return parts[i]
  }
  return undefined
}

/**
 * Classifies a "working → idle" transition as `completed` (the adapter's
 * last MEANINGFUL part was a final assistant text message), `awaiting_input`
 * (the turn ended on a question/permission request — the agent produced
 * real output and is waiting on an answer, neither a finished review nor a
 * run that needs attention), `error` (the last meaningful part is itself an
 * error — e.g. an adapter that reports a provider error as an ordinary part
 * rather than a distinct session-level ERROR status), or `stopped_early`
 * (idle with no meaningful part at all, or the last one is a tool call —
 * e.g. the agent went idle right after "Let's stage and commit").
 *
 * `error` is normally produced by its own dedicated call site (a session
 * status of ERROR, handled before a run ever reaches this idle classifier)
 * — this is a second, narrower path for an adapter that surfaces an error
 * as a plain part instead of a session-level status.
 *
 * Other end reasons (`limit`, `user_stop`, `interrupted`) are never produced
 * here — they come from their own call sites, which already know
 * unambiguously why the run ended.
 */
export function classifyIdleEnd(signal: IdleEndSignal): RunEndReason {
  if (signal.lastPartRole === 'assistant' && signal.lastPartType === 'text') {
    return 'completed'
  }
  if (signal.lastPartRole === 'assistant' && signal.lastPartType === 'question') {
    return 'awaiting_input'
  }
  if (signal.lastPartRole === 'assistant' && signal.lastPartType === 'error') {
    return 'error'
  }
  return 'stopped_early'
}

/**
 * The task status a run's end reason should produce, or `null` when the
 * task's current status should be left exactly as it is. Only a genuinely
 * `completed` run reaches `ready_for_review`. `awaiting_input` is neither a
 * finished review nor a "needs attention" failure — the task stays wherever
 * it already is (normally `agent_working`); the renderer's own pending-
 * question indicator (scanning the transcript, not `task.status`) already
 * surfaces it. Every other reason is a "needs attention" state, surfaced by
 * reusing `model_error` (see `isNeedsAttentionReason` for the UI/parent
 * wake-up copy that explains which one it was).
 */
export function statusForEndReason(reason: RunEndReason): TaskStatus | null {
  if (reason === 'completed') return TaskStatus.ReadyForReview
  if (reason === 'awaiting_input') return null
  return TaskStatus.ModelError
}

/** True for every end reason that is a genuine failure needing attention — NOT a completion, and NOT merely awaiting an answer. */
export function isNeedsAttentionReason(reason: RunEndReason): boolean {
  return reason !== 'completed' && reason !== 'awaiting_input'
}

/** Short, user-facing label for a non-completed end reason — shown on the task and in its parent's wake-up. */
export function describeEndReason(reason: RunEndReason): string {
  switch (reason) {
    case 'stopped_early':
      return 'Stopped before finishing — the agent went idle with no final answer.'
    case 'error':
      return 'Error — the provider reported a terminal error.'
    case 'limit':
      return 'Paused — a usage limit was hit.'
    case 'interrupted':
      return 'Interrupted by restart — the app closed while this was running.'
    case 'user_stop':
      return 'Stopped by the user.'
    case 'awaiting_input':
      return 'Waiting for your answer — the agent asked a question.'
    case 'completed':
      return 'Completed.'
  }
}
