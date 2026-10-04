import { useState, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'

export type UsageChipLevel = 'normal' | 'warning' | 'critical'

const LEVEL_TEXT: Record<UsageChipLevel, string> = {
  normal: 'text-muted-foreground',
  warning: 'text-warning',
  critical: 'text-destructive'
}

const LEVEL_BAR: Record<UsageChipLevel, string> = {
  normal: 'bg-primary',
  warning: 'bg-warning',
  critical: 'bg-destructive'
}

interface UsageChipProps {
  /** Small icon identifying the subscription (provider logo, Peakflo AI mark). */
  icon: ReactNode
  /** Accessible summary, e.g. "Claude: 42% of weekly limit used, resets in 2h". */
  label: string
  percent: number
  level: UsageChipLevel
  limitReached?: boolean
  /** Rich details shown above the chip on hover / keyboard focus. */
  details: ReactNode
  onClick?: () => void
  testId?: string
  detailsTestId?: string
}

/**
 * Compact status-bar meter: icon, a tiny usage bar and the percentage.
 * Hover or focus shows the full details card; it stays open while the
 * pointer moves onto the card.
 */
export function UsageChip({ icon, label, percent, level, limitReached, details, onClick, testId, detailsTestId }: UsageChipProps) {
  const [open, setOpen] = useState(false)
  const used = Math.min(100, Math.max(0, percent))
  return (
    <span
      className="relative flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      data-testid={testId}
    >
      <button
        type="button"
        className={cn(
          'flex items-center gap-1 rounded-sm px-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40',
          LEVEL_TEXT[level]
        )}
        aria-label={label}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={onClick}
      >
        {limitReached ? <AlertTriangle className="h-2.5 w-2.5" aria-hidden /> : <span className="flex h-2.5 w-2.5 items-center justify-center" aria-hidden>{icon}</span>}
        <span className="h-1 w-5 rounded-full bg-muted overflow-hidden" aria-hidden>
          <span className={cn('block h-full rounded-full', LEVEL_BAR[level])} style={{ width: `${used}%` }} />
        </span>
        <span>{Math.round(used)}%</span>
      </button>
      {open && (
        // Bottom padding bridges the gap so the pointer can move onto the card.
        <span className="absolute bottom-full right-0 z-50 pb-1.5 text-left leading-normal" role="tooltip" data-testid={detailsTestId}>
          {details}
        </span>
      )}
    </span>
  )
}
