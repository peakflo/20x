/**
 * Shared types for "children's questions go to the parent first" — the main
 * process, the desktop renderer, and the mobile SPA all need the exact same
 * shape, so it lives here rather than being declared three times.
 *
 * The runtime logic (routing, escalation, the SQLite-backed store) lives in
 * `src/main/orchestration/child-questions.ts`, which imports these types
 * instead of redeclaring them.
 */

export type ChildQuestionKind = 'approval' | 'question'

export type ChildQuestionState = 'pending_parent' | 'escalated' | 'answered_by_parent' | 'answered_by_human' | 'cancelled'

export type ChildQuestionAnsweredBy = 'parent' | 'human'

export interface ChildQuestionOption {
  optionId: string
  label: string
}

export interface ChildQuestionRecord {
  id: string
  childTaskId: string
  parentTaskId: string | null
  questionId: string
  kind: ChildQuestionKind
  questionText: string
  options: ChildQuestionOption[] | null
  toolName: string | null
  command: string | null
  /** Secrets scrubbed — see `scrubSecretsForExcerpt` in child-questions.ts. */
  contextExcerpt: string | null
  /** True when the authority gate reserved this for a human (deploys, merges, destructive commands, payments, external messages). */
  requiresHuman: boolean
  authorityCategories: string[]
  state: ChildQuestionState
  answer: string | null
  optionId: string | null
  /** The parent's note when it explicitly escalated via escalate_to_user. */
  note: string | null
  answeredBy: ChildQuestionAnsweredBy | null
  createdAt: number
  updatedAt: number
  /** When this auto-escalates to the human if the parent hasn't answered. Null once it's no longer pending. */
  escalateAt: number | null
  escalatedAt: number | null
  answeredAt: number | null
}

/** Renderer/mobile IPC and WebSocket channel names for child-question push updates. */
export const CHILD_QUESTION_RAISED_CHANNEL = 'task:childQuestionRaised'
export const CHILD_QUESTION_ANSWERED_CHANNEL = 'task:childQuestionAnswered'
export const CHILD_QUESTION_ESCALATED_CHANNEL = 'task:childQuestionEscalated'

/** Human-readable label for a state, shared by desktop and mobile. */
export function childQuestionStateLabel(state: ChildQuestionState): string {
  switch (state) {
    case 'pending_parent':
      return 'Waiting for parent'
    case 'escalated':
      return 'Escalated to you'
    case 'answered_by_parent':
      return 'Answered by the parent'
    case 'answered_by_human':
      return 'Answered by you'
    case 'cancelled':
      return 'Cancelled'
  }
}
