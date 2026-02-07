import { Badge, type BadgeVariant } from '@/components/ui/Badge'
import type { TaskPriority } from '@/types'

const priorityConfig: Record<TaskPriority, { label: string; variant: BadgeVariant }> = {
  critical: { label: 'Critical', variant: 'red' },
  high: { label: 'High', variant: 'orange' },
  medium: { label: 'Medium', variant: 'yellow' },
  low: { label: 'Low', variant: 'default' }
}

interface TaskPriorityBadgeProps {
  priority: TaskPriority
}

export function TaskPriorityBadge({ priority }: TaskPriorityBadgeProps) {
  const config = priorityConfig[priority]
  return <Badge variant={config.variant}>{config.label}</Badge>
}
