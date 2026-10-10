import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useHarnessMaintenanceStore } from '@/stores/harness-maintenance-store'
import { useUIStore } from '@/stores/ui-store'
import { SettingsTab } from '@/types'
import { harnessDisplayLabel, statusNeedsAttention, type HarnessMaintenanceStatus } from '@shared/harness-maintenance'

const NOTIFIED_KEY = '20x:harness-update-notified'

/** harness -> the version we last showed a notice for, so a dismissed/reviewed version never pops again. */
function loadNotified(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function saveNotified(record: Record<string, string>): void {
  try {
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(record))
  } catch {
    // Best-effort — worst case the same notice reappears once more.
  }
}

/** The version a notice is "about" for a given harness — what changing means a fresh notice is due. */
function noticeVersionKey(status: HarnessMaintenanceStatus): string {
  return status.latestVersion ?? status.version ?? status.status
}

function noticeLine(status: HarnessMaintenanceStatus): string {
  const label = harnessDisplayLabel(status.harness)
  if (status.status === 'unsupported') return `${label} ${status.version ?? ''} is unsupported`
  if (status.status === 'below_recommended') return `${label} ${status.version ?? ''} is below 20x's recommended version`
  return `${label} ${status.version ?? ''} → ${status.latestVersion}`
}

/**
 * A real, hard-to-miss notice — not just a status-bar dot — when a harness
 * CLI is behind latest, below recommended, or unsupported. Shows once per
 * newly-discovered version per harness (dismissing or reviewing marks it so
 * it doesn't pop again for the same version), and works from any screen
 * since it's mounted at the app root, not inside Settings.
 */
export function HarnessUpdateNotice() {
  const statuses = useHarnessMaintenanceStore((s) => s.statuses)
  const init = useHarnessMaintenanceStore((s) => s.init)
  const openSettings = useUIStore((s) => s.openSettings)
  const setSettingsTab = useUIStore((s) => s.setSettingsTab)

  const [pending, setPending] = useState<HarnessMaintenanceStatus[]>([])

  useEffect(() => init(), [init])

  useEffect(() => {
    const notified = loadNotified()
    const unseen = statuses.filter((s) => statusNeedsAttention(s.status) && notified[s.harness] !== noticeVersionKey(s))
    if (unseen.length > 0) setPending(unseen)
  }, [statuses])

  const markNotified = (): void => {
    const notified = loadNotified()
    for (const status of pending) notified[status.harness] = noticeVersionKey(status)
    saveNotified(notified)
    setPending([])
  }

  if (pending.length === 0) return null

  const title = pending.length === 1
    ? `${harnessDisplayLabel(pending[0].harness)} update available`
    : `${pending.length} harness updates available`

  return (
    <div
      className="fixed top-4 right-4 z-50 w-80 rounded-lg border border-border bg-card shadow-lg p-4 space-y-3 animate-in fade-in slide-in-from-top-2"
      data-testid="harness-update-notice"
      role="status"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-muted-foreground mt-1 space-y-0.5">
            {pending.map((s) => <span key={s.harness} className="block">{noticeLine(s)}</span>)}
          </p>
        </div>
        <button
          onClick={markNotified}
          aria-label="Dismiss notice"
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={markNotified}>Dismiss</Button>
        <Button
          size="sm"
          onClick={() => {
            setSettingsTab(SettingsTab.AGENTS)
            openSettings()
            markNotified()
          }}
        >
          Review
        </Button>
      </div>
    </div>
  )
}
