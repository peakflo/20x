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
  'system-status'
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
 * last MEANINGFUL part was a final assistant text message, or the turn ended
 * on a question/permission request — that's waiting for input, not a turn
 * cut short) or `stopped_early` (idle with no meaningful part at all, or the
 * last one is a tool call — e.g. the agent went idle right after "Let's
 * stage and commit").
 *
 * Other end reasons (`error`, `limit`, `user_stop`, `interrupted`) are never
 * produced here — they come from their own call sites, which already know
 * unambiguously why the run ended.
 */
export function classifyIdleEnd(signal: IdleEndSignal): RunEndReason {
  if (signal.lastPartRole === 'assistant' && signal.lastPartType === 'text') {
    return 'completed'
  }
  // A turn that ends with a pending question/permission request isn't cut
  // short — the agent produced real output and is waiting on an answer.
  if (signal.lastPartRole === 'assistant' && signal.lastPartType === 'question') {
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
