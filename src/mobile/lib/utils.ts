import { TaskStatus } from '@shared/constants'

/** Merge class names, filtering out falsy values */
export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}

export function isSnoozed(snoozedUntil: string | null): boolean {
  if (!snoozedUntil) return false
  if (snoozedUntil === '9999-12-31T00:00:00.000Z') return true
  return new Date(snoozedUntil) > new Date()
}

export function isOverdue(dueDate: string | null): boolean {
  if (!dueDate) return false
  return new Date(dueDate) < new Date()
}

export function isDueSoon(dueDate: string | null): boolean {
  if (!dueDate) return false
  const due = new Date(dueDate)
  const now = new Date()
  const hoursUntil = (due.getTime() - now.getTime()) / (1000 * 60 * 60)
  return hoursUntil > 0 && hoursUntil <= 24
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

// Matches desktop TaskListItem statusDotColor exactly
export const STATUS_DOT_COLORS: Record<string, string> = {
  [TaskStatus.NotStarted]: 'bg-muted-foreground',
  [TaskStatus.Triaging]: 'bg-muted-foreground animate-pulse',
  [TaskStatus.AgentWorking]: 'bg-amber-400',
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

// Badge variant mappings — matches desktop Badge.tsx variants
export type BadgeVariant = 'default' | 'blue' | 'green' | 'yellow' | 'red' | 'purple' | 'orange'

export const BADGE_VARIANTS: Record<BadgeVariant, string> = {
  default: 'border-border/50 bg-muted text-muted-foreground',
  blue: 'border-blue-500/20 bg-blue-500/10 text-blue-400',
  green: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400',
  yellow: 'border-amber-500/20 bg-amber-500/10 text-amber-400',
  red: 'border-red-500/20 bg-red-500/10 text-red-400',
  purple: 'border-purple-500/20 bg-purple-500/10 text-purple-400',
  orange: 'border-orange-500/20 bg-orange-500/10 text-orange-400'
}

export const PRIORITY_VARIANT: Record<string, { label: string; variant: BadgeVariant }> = {
  critical: { label: 'Critical', variant: 'red' },
  high: { label: 'High', variant: 'orange' },
  medium: { label: 'Medium', variant: 'yellow' },
  low: { label: 'Low', variant: 'default' }
}

export const STATUS_VARIANT: Record<string, { label: string; variant: BadgeVariant }> = {
  [TaskStatus.NotStarted]: { label: 'Not Started', variant: 'default' },
  [TaskStatus.Triaging]: { label: 'Triaging', variant: 'default' },
  [TaskStatus.AgentWorking]: { label: 'Agent Working', variant: 'yellow' },
  [TaskStatus.ReadyForReview]: { label: 'Ready for Review', variant: 'purple' },
  [TaskStatus.AgentLearning]: { label: 'Agent Learning', variant: 'blue' },
  [TaskStatus.Completed]: { label: 'Completed', variant: 'green' }
}
