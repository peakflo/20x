import { PRIORITY_COLORS } from '../lib/utils'

export function PriorityBadge({ priority }: { priority: string }) {
  const colors = PRIORITY_COLORS[priority] || PRIORITY_COLORS.medium
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${colors}`}>
      {priority}
    </span>
  )
}
