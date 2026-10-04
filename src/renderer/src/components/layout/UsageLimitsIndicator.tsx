import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUsageStore } from '@/stores/usage-store'
import { useUIStore } from '@/stores/ui-store'
import { SettingsTab } from '@/types'
import { ProviderLimitsCard } from '@/components/usage/ProviderLimitsCard'
import {
  effectiveUsedPercent,
  formatResetIn,
  usageLimitLevel,
  type ProviderUsageLimits,
  type UsageProvider
} from '@shared/usage'

/** Background re-check while the app is open (the main process throttles further). */
const BACKGROUND_REFRESH_MS = 10 * 60 * 1000
/** Re-render cadence so "resets in" countdowns and rolled-over windows stay current. */
const CLOCK_TICK_MS = 60 * 1000

const SHORT_LABELS: Record<UsageProvider, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  pi: 'Pi'
}

const LEVEL_TEXT = {
  normal: 'text-muted-foreground',
  warning: 'text-warning',
  critical: 'text-destructive'
} as const

const LEVEL_BAR = {
  normal: 'bg-primary',
  warning: 'bg-warning',
  critical: 'bg-destructive'
} as const

/** The window closest to its limit decides what the status bar shows. */
function mostConstrained(limits: ProviderUsageLimits, nowMs: number) {
  let best = limits.windows[0]
  let bestUsed = effectiveUsedPercent(best, nowMs)
  for (const window of limits.windows.slice(1)) {
    const used = effectiveUsedPercent(window, nowMs)
    if (used > bestUsed) {
      best = window
      bestUsed = used
    }
  }
  return { window: best, used: bestUsed }
}

function ProviderChip({ limits, nowMs }: { limits: ProviderUsageLimits; nowMs: number }) {
  const [open, setOpen] = useState(false)
  const openSettings = useUIStore((s) => s.openSettings)
  const setSettingsTab = useUIStore((s) => s.setSettingsTab)
  const { window, used } = mostConstrained(limits, nowMs)
  const level = limits.limitReached ? 'critical' : usageLimitLevel(used)
  const label = SHORT_LABELS[limits.provider]
  const resetIn = formatResetIn(window.resetsAt, nowMs)
  const summary = `${label}: ${Math.round(used)}% of ${window.label.toLowerCase()} limit used${resetIn ? `, resets ${resetIn}` : ''}`

  return (
    <span
      className="relative flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      data-testid={`usage-chip-${limits.provider}`}
    >
      <button
        type="button"
        className={cn(
          'flex items-center gap-1 rounded-sm px-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40',
          LEVEL_TEXT[level]
        )}
        aria-label={summary}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => {
          setSettingsTab(SettingsTab.USAGE)
          openSettings()
        }}
      >
        {limits.limitReached && <AlertTriangle className="h-2.5 w-2.5" />}
        <span>{label}</span>
        <span className="h-1 w-5 rounded-full bg-muted overflow-hidden" aria-hidden>
          <span className={cn('block h-full rounded-full', LEVEL_BAR[level])} style={{ width: `${used}%` }} />
        </span>
        <span>{Math.round(used)}%</span>
      </button>
      {open && (
        // Bottom padding bridges the gap so the pointer can move onto the card.
        <span className="absolute bottom-full right-0 z-50 pb-1.5" role="tooltip">
          <ProviderLimitsCard limits={limits} className="w-72 shadow-lg text-left leading-normal" />
        </span>
      )}
    </span>
  )
}

/**
 * Status-bar chips with the most constrained subscription window per provider
 * (Claude Code, Codex, Cursor, OpenCode Go). Hover for the full breakdown;
 * click to open Settings → Usage. Providers without readings are hidden.
 */
export function UsageLimitsIndicator() {
  const limits = useUsageStore((s) => s.limits)
  const init = useUsageStore((s) => s.init)
  const refresh = useUsageStore((s) => s.refresh)
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => init(), [init])

  useEffect(() => {
    const refreshTimer = setInterval(() => { void refresh(false) }, BACKGROUND_REFRESH_MS)
    const clockTimer = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS)
    return () => {
      clearInterval(refreshTimer)
      clearInterval(clockTimer)
    }
  }, [refresh])

  const visible = limits.filter((l) => l.windows.length > 0)
  if (visible.length === 0) return null

  return (
    <span className="flex items-center gap-3" data-testid="usage-limits-indicator">
      {visible.map((providerLimits) => (
        <ProviderChip key={providerLimits.provider} limits={providerLimits} nowMs={nowMs} />
      ))}
    </span>
  )
}
