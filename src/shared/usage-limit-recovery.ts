/**
 * Automatic continuation of tasks that stopped on a subscription usage limit.
 *
 * When an agent turn stops because a plan limit was hit, the main process
 * records a recovery for the task with the time the blocking window resets.
 * Once that time has passed (and auto-resume is on) it sends
 * {@link LIMIT_RECOVERY_CONTINUE_MESSAGE} to the task's agent session.
 */

import type { UsageProvider } from './usage'

/**
 * - `waiting`: stopped on a limit; will continue at `resetAt` if `autoResume`.
 * - `resumed`: the continuation was sent.
 * - `cancelled`: the user cancelled the scheduled continuation.
 * - `superseded`: the user sent their own message (or the task moved on).
 * - `failed`: the continuation could not be sent (see `error`).
 */
export type UsageLimitRecoveryStatus = 'waiting' | 'resumed' | 'cancelled' | 'superseded' | 'failed'

export interface UsageLimitRecovery {
  taskId: string
  agentId: string | null
  provider: UsageProvider | null
  /** Provider session id the stop happened on. */
  sessionId: string | null
  /** Unix ms the stop was observed. */
  stoppedAt: number
  /** ISO time the blocking window(s) reset; null when unknown (manual resume only). */
  resetAt: string | null
  /** Continue automatically once `resetAt` passes. */
  autoResume: boolean
  status: UsageLimitRecoveryStatus
  /** Provider error text shown to the user. */
  message: string | null
  /** Automatic continuations in a row that hit the limit again (loop guard). */
  attempts: number
  /** Unix ms the continuation was sent. */
  resumedAt: number | null
  error: string | null
}

/** Text sent to the agent when its limit window resets. */
export const LIMIT_RECOVERY_CONTINUE_MESSAGE = 'Continue where you left off.'

/** Setting: automatically continue tasks after a usage-limit reset ('true' | 'false'; default on). */
export const AUTO_RESUME_LIMITED_TASKS_SETTING = 'usage.autoResumeLimitedTasks'

/** Payload: `UsageLimitRecovery`. */
export const USAGE_LIMIT_RECOVERY_UPDATED_CHANNEL = 'usage:limit-recovery-updated'

export function isAutoResumeSettingEnabled(value: string | null | undefined): boolean {
  return value !== 'false'
}
