export type AutomationRunNowTarget =
  | { type: 'responsibility'; id: string }
  | { type: 'schedule'; id: string }

export type AutomationRunNowStatus = 'queued' | 'started' | 'already_running' | 'already_queued' | 'not_runnable'

export interface AutomationRunNowResult {
  status: AutomationRunNowStatus
  message: string
  target: AutomationRunNowTarget
  nextAt?: string | null
}

export interface AutomationRunNowApi {
  runNow(target: AutomationRunNowTarget): Promise<AutomationRunNowResult>
}
