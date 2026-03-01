import { STATUS_COLORS } from '../lib/utils'

export function TaskStatusDot({ status }: { status: string }) {
  const color = STATUS_COLORS[status] || 'bg-slate-500'
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${color}`} />
}
