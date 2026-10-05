import { useEffect, useState } from 'react'
import { useUsageStore } from '@/stores/usage-store'
import { useUIStore } from '@/stores/ui-store'
import { SettingsTab } from '@/types'
import { ProviderLimitsCard } from '@/components/usage/ProviderLimitsCard'
import { ProviderLogo } from '@/components/usage/ProviderLogo'
import { UsageChip } from '@/components/usage/UsageChip'
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

/** Spoken/accessible names (the chip itself shows the provider logo). */
const SHORT_LABELS: Record<UsageProvider, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  pi: 'Pi'
}

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

/** Name of the account a chip belongs to, e.g. "Codex · Work". The default account has no separate name. */
function accountName(limits: ProviderUsageLimits, showName: boolean): string | undefined {
  if (!showName || !limits.instanceLabel) return undefined
  return limits.instanceLabel
}

function ProviderChip({ limits, nowMs, showName }: { limits: ProviderUsageLimits; nowMs: number; showName: boolean }) {
  const openSettings = useUIStore((s) => s.openSettings)
  const setSettingsTab = useUIStore((s) => s.setSettingsTab)
  const { window, used } = mostConstrained(limits, nowMs)
  const level = limits.limitReached ? 'critical' : usageLimitLevel(used)
  const resetIn = formatResetIn(window.resetsAt, nowMs)
  const name = accountName(limits, showName)
  const label = `${name ?? SHORT_LABELS[limits.provider]}: ${Math.round(used)}% of ${window.label.toLowerCase()} limit used${resetIn ? `, resets ${resetIn}` : ''}`

  return (
    <UsageChip
      icon={<ProviderLogo provider={limits.provider} className="h-2.5 w-2.5" />}
      name={name}
      label={label}
      percent={used}
      level={level}
      limitReached={limits.limitReached}
      details={<ProviderLimitsCard limits={limits} className="w-72 shadow-lg" />}
      onClick={() => {
        setSettingsTab(SettingsTab.USAGE)
        openSettings()
      }}
      testId={`usage-chip-${limits.instanceId ?? limits.provider}`}
    />
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
  // Chips carry the account name only when a harness has more than one account to tell apart.
  const countByProvider = new Map<string, number>()
  for (const l of visible) countByProvider.set(l.provider, (countByProvider.get(l.provider) ?? 0) + 1)

  return (
    <span className="flex items-center gap-3" data-testid="usage-limits-indicator">
      {visible.map((instanceLimits) => {
        const isCustomAccount = !!instanceLimits.instanceId && !instanceLimits.instanceId.startsWith('default:')
        const showName = isCustomAccount || (countByProvider.get(instanceLimits.provider) ?? 0) > 1
        return (
          <ProviderChip
            key={instanceLimits.instanceId ?? instanceLimits.provider}
            limits={instanceLimits}
            nowMs={nowMs}
            showName={showName}
          />
        )
      })}
    </span>
  )
}
