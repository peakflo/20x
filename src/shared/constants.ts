export enum TaskStatus {
  NotStarted = 'not_started',
  AgentWorking = 'agent_working',
  ReadyForReview = 'ready_for_review',
  Completed = 'completed'
}

export const TASK_STATUSES: { value: TaskStatus; label: string }[] = [
  { value: TaskStatus.NotStarted, label: 'Not Started' },
  { value: TaskStatus.AgentWorking, label: 'Agent Working' },
  { value: TaskStatus.ReadyForReview, label: 'Ready for Review' },
  { value: TaskStatus.Completed, label: 'Completed' }
]
