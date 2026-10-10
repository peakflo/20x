import { useEffect } from 'react'
import { useHarnessMaintenanceStore } from '@/stores/harness-maintenance-store'
import { useUIStore } from '@/stores/ui-store'
import { SettingsTab } from '@/types'
import { statusNeedsAttention } from '@shared/harness-maintenance'

/**
 * A subtle status-bar dot when any harness has an update, is below 20x's
 * recommended version, or is unsupported. Click opens Settings → Agents. No
 * OS notification here — this is the one quiet, always-available indicator.
 */
export function HarnessUpdateIndicator() {
  const statuses = useHarnessMaintenanceStore((s) => s.statuses)
  const init = useHarnessMaintenanceStore((s) => s.init)
  const openSettings = useUIStore((s) => s.openSettings)
  const setSettingsTab = useUIStore((s) => s.setSettingsTab)

  useEffect(() => init(), [init])

  const flagged = statuses.filter((s) => statusNeedsAttention(s.status))
  if (flagged.length === 0) return null

  const title = flagged.length === 1
    ? `A harness update is available (${flagged[0].harness})`
    : `${flagged.length} harnesses have an update available`

  return (
    <button
      onClick={() => { setSettingsTab(SettingsTab.AGENTS); openSettings() }}
      className="flex items-center gap-1"
      title={title}
      aria-label={title}
      data-testid="harness-update-indicator"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-warning" />
    </button>
  )
}
