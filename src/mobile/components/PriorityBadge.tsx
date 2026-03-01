import { Badge } from './Badge'
import { PRIORITY_VARIANT } from '../lib/utils'

export function PriorityBadge({ priority }: { priority: string }) {
  const config = PRIORITY_VARIANT[priority] || PRIORITY_VARIANT.medium
  return <Badge variant={config.variant}>{config.label}</Badge>
}
