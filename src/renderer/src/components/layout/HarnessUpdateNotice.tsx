import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useHarnessMaintenanceStore } from '@/stores/harness-maintenance-store'
import { useProgressToastStore } from '@/stores/progress-toast-store'
import { useUIStore } from '@/stores/ui-store'
import { SettingsTab } from '@/types'
import { harnessDisplayLabel, statusNeedsAttention, type HarnessMaintenanceStatus } from '@shared/harness-maintenance'

const NOTIFIED_KEY = '20x:harness-update-notified'
const PROGRESS_TOAST_ID = 'harness-update'

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
  const update = useHarnessMaintenanceStore((s) => s.update)
  const updates = useHarnessMaintenanceStore((s) => s.updates)
  const openSettings = useUIStore((s) => s.openSettings)
  const setSettingsTab = useUIStore((s) => s.setSettingsTab)

  const [pending, setPending] = useState<HarnessMaintenanceStatus[]>([])
  const [updating, setUpdating] = useState(false)
  const [attempted, setAttempted] = useState(false)
  /** User hid the notice while an update runs — progress moves to a toast. */
  const [hidden, setHidden] = useState(false)
  const hiddenRef = useRef(false)
  const setHiddenState = (value: boolean): void => {
    hiddenRef.current = value
    setHidden(value)
  }

  useEffect(() => init(), [init])

  useEffect(() => {
    if (updating || attempted) return
    const notified = loadNotified()
    const unseen = statuses.filter((s) => statusNeedsAttention(s.status) && notified[s.harness] !== noticeVersionKey(s))
    setPending(unseen)
  }, [statuses, updating, attempted])

  const markNotified = (toMark: HarnessMaintenanceStatus[] = pending): void => {
    const notified = loadNotified()
    for (const status of toMark) notified[status.harness] = noticeVersionKey(status)
    saveNotified(notified)
    setPending((current) => current.filter((s) => !toMark.some((done) => done.harness === s.harness)))
    setAttempted(false)
  }

  const updateTargets = pending.filter((status) =>
    status.canUpdate && (!attempted || updates[status.harness]?.run?.status === 'failed')
  )
  const hasFailed = attempted && pending.some((status) => updates[status.harness]?.run?.status === 'failed')

  const handleUpdate = async (): Promise<void> => {
    if (updating || updateTargets.length === 0) return
    const targets = updateTargets
    setUpdating(true)
    try {
      // The maintenance service applies installer locks. Run each selected
      // harness in order so the notice reports a result for every one.
      for (const status of targets) await update(status.harness)
    } finally {
      setUpdating(false)
      const results = useHarnessMaintenanceStore.getState().updates
      const allSucceeded = targets.every((status) => results[status.harness]?.run?.status === 'succeeded')
      if (!allSucceeded) {
        // Bring the notice back so a failed/unchanged result (and "Try again") is visible.
        useProgressToastStore.getState().remove(PROGRESS_TOAST_ID)
        setAttempted(true)
        setHiddenState(false)
      } else {
        // Success: just the standard auto-dismissing success toast. Harnesses
        // that need a manual update stay in the notice unless it was hidden.
        const toasts = useProgressToastStore.getState()
        toasts.show(PROGRESS_TOAST_ID, 'Harness updated')
        toasts.finish(
          PROGRESS_TOAST_ID,
          targets.map((s) => `${harnessDisplayLabel(s.harness)}: ${results[s.harness]?.run?.message ?? 'Updated.'}`).join(' ')
        )
        markNotified(hiddenRef.current ? pending : targets)
        setHiddenState(false)
      }
    }
  }

  const hideWhileUpdating = (): void => {
    setHiddenState(true)
    useProgressToastStore.getState().show(
      PROGRESS_TOAST_ID,
      'Updating harness…',
      updateTargets.map((s) => harnessDisplayLabel(s.harness)).join(', ')
    )
  }

  if (pending.length === 0 || hidden) return null

  const title = updating
    ? 'Updating harness…'
    : attempted
      ? hasFailed ? 'Harness update failed' : 'Harness update complete'
      : pending.length === 1
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
            {pending.map((s) => (
              <span key={s.harness} className="block">
                {attempted && updates[s.harness]?.run
                  ? `${harnessDisplayLabel(s.harness)}: ${updates[s.harness].run?.message ?? updates[s.harness].run?.status}`
                  : noticeLine(s)}
              </span>
            ))}
          </p>
        </div>
        <button
          onClick={() => (updating ? hideWhileUpdating() : markNotified())}
          aria-label={updating ? 'Hide notice' : 'Dismiss notice'}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => (updating ? hideWhileUpdating() : markNotified())}>
          {updating ? 'Hide' : 'Dismiss'}
        </Button>
        <Button
          size="sm"
          variant={updateTargets.length > 0 ? 'outline' : 'default'}
          disabled={updating}
          onClick={() => {
            setSettingsTab(SettingsTab.HARNESSES)
            openSettings()
            markNotified()
          }}
        >
          Review
        </Button>
        {updateTargets.length > 0 && (
          <Button size="sm" onClick={() => void handleUpdate()} disabled={updating || updateTargets.some((s) => updates[s.harness]?.running)}>
            {updating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {updating ? 'Updating…' : attempted ? 'Try again' : updateTargets.length === 1 ? 'Update now' : 'Update all'}
          </Button>
        )}
      </div>
    </div>
  )
}
