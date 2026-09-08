export type RecurrenceMode = 'reuse' | 'separate'
export const isReusableSchedule = (task?: { is_recurring: boolean; recurrence_parent_id?: string | null; recurrence_mode?: string } | null): boolean =>
  !!task?.is_recurring && !task.recurrence_parent_id && task.recurrence_mode === 'reuse'

export function recurrenceMode(value: unknown, fallback: RecurrenceMode = 'reuse'): RecurrenceMode {
  if (value === undefined) return fallback
  if (value !== 'reuse' && value !== 'separate') throw new Error('Choose reuse or separate for the schedule execution mode.')
  return value
}

export interface ScheduleRun {
  id: string
  taskId: string
  dueAt: string
  startedAt: string | null
  finishedAt: string | null
  state: 'pending' | 'starting' | 'running' | 'waiting_approval' | 'finished' | 'failed' | 'interrupted'
  agentId: string | null
  sessionId: string | null
  summary: string
  artifacts: { title: string; path: string }[]
}
