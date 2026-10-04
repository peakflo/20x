import { TaskStatus } from '@/types'

/**
 * What the R shortcut does for the selected task. The first four are the same
 * actions the task's primary button offers, so R and the button cannot
 * disagree about what a task needs.
 */
export enum RunShortcutAction {
  /** Assigned agent, no persisted session yet: start one. */
  START = 'start',
  /** Assigned agent, persisted session with no transcript loaded: resume it. */
  RESUME = 'resume',
  /** Assigned agent, persisted session with a transcript: start a fresh session. */
  RESTART = 'restart',
  /** Unassigned task: triage with the default agent, which also starts it. */
  TRIAGE = 'triage'
}

export interface RunShortcutInput {
  taskStatus: TaskStatus | string
  /** agent_id of the task. Null or undefined means the task is unassigned. */
  assignedAgent: string | null | undefined
  /** Whether the assigned agent (or, for unassigned tasks, the triage agent) is set up. */
  agentConfigured: boolean
  /** session_id persisted on the task. */
  persistedSessionId: string | null | undefined
  /** Session currently held in memory for this task. */
  liveSessionId: string | null | undefined
  /** Whether the in-memory session is idle. Anything else means a session is busy. */
  liveSessionIdle: boolean
  /** Number of messages loaded in the in-memory session. */
  liveMessageCount: number
}

export type RunShortcutDecision =
  | { action: RunShortcutAction; blockedReason?: undefined }
  | { action: null; blockedReason: string }

/**
 * Decides what R does. Pure so the assigned and unassigned branches can be
 * tested without rendering the workspace. A blocked decision carries a reason
 * so the user gets feedback instead of a key press that silently does nothing.
 */
export function resolveRunShortcut(input: RunShortcutInput): RunShortcutDecision {
  if (input.taskStatus === TaskStatus.Completed) {
    return { action: null, blockedReason: 'This task is already completed' }
  }
  if (input.liveSessionId || !input.liveSessionIdle) {
    return { action: null, blockedReason: 'The agent is already running on this task' }
  }

  if (input.assignedAgent) {
    if (!input.agentConfigured) {
      return { action: null, blockedReason: 'The assigned agent is not configured' }
    }
    if (!input.persistedSessionId) return { action: RunShortcutAction.START }
    if (input.liveMessageCount === 0) return { action: RunShortcutAction.RESUME }
    return { action: RunShortcutAction.RESTART }
  }

  if (input.taskStatus === TaskStatus.Triaging) {
    return { action: null, blockedReason: 'Triage is already in progress' }
  }
  if (!input.agentConfigured) {
    return { action: null, blockedReason: 'No agent is configured for triage' }
  }
  return { action: RunShortcutAction.TRIAGE }
}
