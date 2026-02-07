import { Code, Hand, Eye, CheckCircle, Circle, type LucideIcon } from 'lucide-react'
import { Badge, type BadgeVariant } from '@/components/ui/Badge'
import type { TaskType } from '@/types'

const typeConfig: Record<TaskType, { label: string; icon: LucideIcon; variant: BadgeVariant }> = {
  coding: { label: 'Coding', icon: Code, variant: 'blue' },
  manual: { label: 'Manual', icon: Hand, variant: 'default' },
  review: { label: 'Review', icon: Eye, variant: 'purple' },
  approval: { label: 'Approval', icon: CheckCircle, variant: 'green' },
  general: { label: 'General', icon: Circle, variant: 'default' }
}

interface TaskTypeBadgeProps {
  type: TaskType
}

export function TaskTypeBadge({ type }: TaskTypeBadgeProps) {
  const config = typeConfig[type]
  const Icon = config.icon
  return (
    <Badge variant={config.variant}>
      <Icon className="h-3 w-3 mr-1" />
      {config.label}
    </Badge>
  )
}
