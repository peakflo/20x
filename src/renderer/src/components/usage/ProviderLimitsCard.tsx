import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { ProviderLogo } from './ProviderLogo'
import {
  USAGE_PROVIDER_LABELS,
  effectiveUsedPercent,
  formatResetIn,
  usageLimitLevel,
  type ProviderUsageLimits,
  type UsageLimitWindow
} from '@shared/usage'

const LEVEL_BAR: Record<ReturnType<typeof usageLimitLevel>, string> = {
  normal: 'bg-primary',
  warning: 'bg-warning',
  critical: 'bg-destructive'
}

function formatPlan(planType: string | null | undefined): string | null {
  if (!planType) return null
  return planType.charAt(0).toUpperCase() + planType.slice(1)
}

function formatCheckedAt(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const minutes = Math.round((Date.now() - ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(ms).toLocaleDateString()
}

export function LimitWindowRow({ window }: { window: UsageLimitWindow }) {
  const used = effectiveUsedPercent(window)
  const level = usageLimitLevel(used)
  const resetIn = formatResetIn(window.resetsAt)
  return (
    <div className="space-y-1.5" data-testid={`usage-window-${window.id}`}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium text-foreground">{window.label}</span>
        <span className="text-muted-foreground tabular-nums">
          {Math.round(used)}% used{resetIn ? ` · resets ${resetIn}` : ''}
        </span>
      </div>
      <div
        className="h-1.5 w-full rounded-full bg-muted overflow-hidden"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(used)}
        aria-label={`${window.label}: ${Math.round(used)}% used`}
      >
        <div className={cn('h-full rounded-full transition-[width]', LEVEL_BAR[level])} style={{ width: `${used}%` }} />
      </div>
    </div>
  )
}

export function ProviderLimitsCard({
  limits,
  onAction,
  actionPending = false,
  className
}: {
  limits: ProviderUsageLimits
  /** Handler for the card's provider action (e.g. allow Keychain access). Omit to hide the button. */
  onAction?: (actionId: string) => void
  actionPending?: boolean
  className?: string
}) {
  const plan = formatPlan(limits.planType)
  const stale = limits.unavailable?.reason === 'probe_failed'
  return (
    <div className={cn('rounded-lg border border-border bg-card p-4 space-y-3', className)} data-testid={`usage-limits-${limits.provider}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <ProviderLogo provider={limits.provider} tinted className="h-3.5 w-3.5" />
          <span className="text-sm font-semibold text-foreground">{USAGE_PROVIDER_LABELS[limits.provider]}</span>
          {plan && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">{plan}</span>
          )}
        </div>
        <span className="text-[11px] text-muted-foreground shrink-0">Checked {formatCheckedAt(limits.checkedAt)}</span>
      </div>

      {limits.limitReached && (
        <div className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>Limit reached — requests are blocked until the window resets.</span>
        </div>
      )}

      {limits.windows.length > 0 ? (
        <div className="space-y-3">
          {limits.windows.map((window) => <LimitWindowRow key={window.id} window={window} />)}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {limits.unavailable?.message ?? 'No plan limits reported yet.'}
        </p>
      )}

      {stale && limits.windows.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          Last refresh failed ({limits.unavailable?.message}); showing the previous reading.
        </p>
      )}
      {limits.action && onAction && (
        <Button size="sm" variant="outline" disabled={actionPending} onClick={() => onAction(limits.action!.id)}>
          {limits.action.label}
        </Button>
      )}
      {typeof limits.resetCreditsAvailable === 'number' && limits.resetCreditsAvailable > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {limits.resetCreditsAvailable} rate-limit reset credit{limits.resetCreditsAvailable === 1 ? '' : 's'} banked
        </p>
      )}
    </div>
  )
}
