import { Cloud } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Marks an artifact that lives in Spaces (read-only in 20x). */
export function SpacesBadge({ className }: { className?: string }) {
  return (
    <span
      data-testid="spaces-badge"
      title="Stored in Spaces · read-only"
      className={cn('inline-flex shrink-0 items-center gap-1 rounded bg-sky-500/15 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-sky-500', className)}
    >
      <Cloud className="h-2.5 w-2.5" aria-hidden />Spaces
    </span>
  )
}
