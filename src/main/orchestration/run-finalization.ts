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
export type RunEndReason = 'completed' | 'stopped_early' | 'error' | 'interrupted' | 'limit' | 'user_stop'

export interface IdleEndSignal {
  /** Role of the very last transcript part seen since the run started (reset on every send). */
  lastPartRole?: string | null
  /** Part type of the very last transcript part seen since the run started. */
  lastPartType?: string | null
}

/**
 * Classifies a "working → idle" transition as `completed` (the adapter's
 * last part was a final assistant text message) or `stopped_early` (idle
 * with no final assistant message at all, or the last part is a tool call —
 * e.g. the agent went idle right after "Let's stage and commit").
 *
 * Other end reasons (`error`, `limit`, `user_stop`, `interrupted`) are never
 * produced here — they come from their own call sites, which already know
 * unambiguously why the run ended.
 */
export function classifyIdleEnd(signal: IdleEndSignal): RunEndReason {
  if (signal.lastPartRole === 'assistant' && signal.lastPartType === 'text') {
    return 'completed'
  }
  return 'stopped_early'
}

/**
 * The task status a run's end reason should produce. Only a genuinely
 * `completed` run reaches `ready_for_review` — every other reason is a
 * "needs attention" state, surfaced by reusing `model_error` (see
 * `NEEDS_ATTENTION_REASONS`/`isNeedsAttentionReason` for the UI/parent
 * wake-up copy that explains which one it was).
 */
export function statusForEndReason(reason: RunEndReason): TaskStatus {
  return reason === 'completed' ? TaskStatus.ReadyForReview : TaskStatus.ModelError
}

/** True for every end reason that is NOT a genuine, honest completion. */
export function isNeedsAttentionReason(reason: RunEndReason): boolean {
  return reason !== 'completed'
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
    case 'completed':
      return 'Completed.'
  }
}
