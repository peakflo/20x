import { STATUS_DOT_COLORS } from '../lib/utils'

export function TaskStatusDot({ status, className = '' }: { status: string; className?: string }) {
  const color = STATUS_DOT_COLORS[status] || 'bg-muted-foreground'
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${color} ${className}`} />
}
