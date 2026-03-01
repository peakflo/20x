import { TaskStatus } from '@shared/constants'

export function isSnoozed(snoozedUntil: string | null): boolean {
  if (!snoozedUntil) return false
  if (snoozedUntil === '9999-12-31T00:00:00.000Z') return true
  return new Date(snoozedUntil) > new Date()
}

export function isOverdue(dueDate: string | null): boolean {
  if (!dueDate) return false
  return new Date(dueDate) < new Date()
}

export function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHrs = Math.floor(diffMin / 60)
  const diffDays = Math.floor(diffHrs / 24)

  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHrs < 24) return `${diffHrs}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}

export const STATUS_COLORS: Record<string, string> = {
  [TaskStatus.NotStarted]: 'bg-slate-500',
  [TaskStatus.Triaging]: 'bg-slate-400 animate-pulse',
  [TaskStatus.AgentWorking]: 'bg-amber-400 animate-pulse',
  [TaskStatus.ReadyForReview]: 'bg-purple-400',
  [TaskStatus.AgentLearning]: 'bg-blue-400',
  [TaskStatus.Completed]: 'bg-emerald-400'
}

export const STATUS_LABELS: Record<string, string> = {
  [TaskStatus.NotStarted]: 'Not Started',
  [TaskStatus.Triaging]: 'Triaging',
  [TaskStatus.AgentWorking]: 'Agent Working',
  [TaskStatus.ReadyForReview]: 'Ready for Review',
  [TaskStatus.AgentLearning]: 'Agent Learning',
  [TaskStatus.Completed]: 'Completed'
}

export const PRIORITY_COLORS: Record<string, string> = {
  critical: 'bg-red-500/20 text-red-300 border-red-500/30',
  high: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
  medium: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  low: 'bg-slate-500/20 text-slate-400 border-slate-500/30'
}

export const SESSION_STATUS_COLORS: Record<string, string> = {
  idle: 'text-muted-foreground',
  working: 'text-green-400',
  error: 'text-red-400',
  waiting_approval: 'text-yellow-400'
}
