import { Badge, type BadgeVariant } from '@/components/ui/Badge'
import { TaskStatus } from '@/types'

const statusConfig: Record<TaskStatus, { label: string; variant: BadgeVariant }> = {
  [TaskStatus.NotStarted]: { label: 'Not Started', variant: 'default' },
  [TaskStatus.AgentWorking]: { label: 'Agent Working', variant: 'yellow' },
  [TaskStatus.ReadyForReview]: { label: 'Ready for Review', variant: 'purple' },
  [TaskStatus.Completed]: { label: 'Completed', variant: 'green' }
}

interface TaskStatusBadgeProps {
  status: TaskStatus
}

export function TaskStatusBadge({ status }: TaskStatusBadgeProps) {
  const config = statusConfig[status]
  return <Badge variant={config.variant}>{config.label}</Badge>
}
