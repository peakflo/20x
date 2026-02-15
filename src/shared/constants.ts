export enum TaskStatus {
  NotStarted = 'not_started',
  AgentWorking = 'agent_working',
  ReadyForReview = 'ready_for_review',
  AgentLearning = 'agent_learning',
  Completed = 'completed'
}

export const TASK_STATUSES: { value: TaskStatus; label: string }[] = [
  { value: TaskStatus.NotStarted, label: 'Not Started' },
  { value: TaskStatus.AgentWorking, label: 'Agent Working' },
  { value: TaskStatus.ReadyForReview, label: 'Ready for Review' },
  { value: TaskStatus.AgentLearning, label: 'Agent Learning' },
  { value: TaskStatus.Completed, label: 'Completed' }
]
