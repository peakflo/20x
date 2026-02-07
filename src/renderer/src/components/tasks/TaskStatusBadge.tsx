import { Badge, type BadgeVariant } from '@/components/ui/Badge'
import type { TaskStatus } from '@/types'

const statusConfig: Record<TaskStatus, { label: string; variant: BadgeVariant }> = {
  inbox: { label: 'Inbox', variant: 'default' },
  accepted: { label: 'Accepted', variant: 'blue' },
  in_progress: { label: 'In Progress', variant: 'purple' },
  pending_review: { label: 'Pending Review', variant: 'yellow' },
  completed: { label: 'Completed', variant: 'green' },
  cancelled: { label: 'Cancelled', variant: 'red' }
}

interface TaskStatusBadgeProps {
  status: TaskStatus
}

export function TaskStatusBadge({ status }: TaskStatusBadgeProps) {
  const config = statusConfig[status]
  return <Badge variant={config.variant}>{config.label}</Badge>
}
