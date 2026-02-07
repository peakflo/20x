import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  action?: React.ReactNode
  className?: string
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-4 py-16 text-center px-8', className)}>
      <div className="rounded-xl bg-muted/50 border border-border p-4">
        <Icon className="h-7 w-7 text-muted-foreground/50" strokeWidth={1.5} />
      </div>
      <div className="space-y-1.5">
        <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
        <p className="text-xs text-muted-foreground/60 max-w-[240px] leading-relaxed">{description}</p>
      </div>
      {action}
    </div>
  )
}
