import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { onEvent } from '../api/websocket'
import {
  HARNESS_MAINTENANCE_PROGRESS_CHANNEL,
  HARNESS_MAINTENANCE_UPDATED_CHANNEL,
  harnessDisplayLabel,
  type HarnessKey,
  type HarnessMaintenanceStatus,
  type HarnessMaintenanceStatusValue
} from '@shared/harness-maintenance'

const STATUS_LABEL: Record<HarnessMaintenanceStatusValue, string> = {
  up_to_date: 'Up to date',
  behind_latest: 'Update available',
  below_recommended: 'Below recommended',
  unsupported: 'Unsupported',
  not_installed: 'Not installed',
  unknown: 'Status unknown'
}

const STATUS_DOT: Record<HarnessMaintenanceStatusValue, string> = {
  up_to_date: 'bg-muted-foreground/40',
  behind_latest: 'bg-primary',
  below_recommended: 'bg-yellow-400',
  unsupported: 'bg-destructive',
  not_installed: 'bg-muted-foreground/40',
  unknown: 'bg-muted-foreground/40'
}

function upsert(list: HarnessMaintenanceStatus[], incoming: HarnessMaintenanceStatus[]): HarnessMaintenanceStatus[] {
  const byHarness = new Map(list.map((s) => [s.harness, s]))
  for (const status of incoming) byHarness.set(status.harness, status)
  return [...byHarness.values()]
}

/**
 * Mobile Settings: read-only harness versions, plus "Update now" — the
 * update itself always runs on the desktop host the phone is paired to, so
 * triggering it from here is exactly as safe as clicking it on desktop.
 */
export function HarnessMaintenanceSection() {
  const [statuses, setStatuses] = useState<HarnessMaintenanceStatus[]>([])
  const [checking, setChecking] = useState(false)
  const [updating, setUpdating] = useState<HarnessKey | null>(null)
  const [progress, setProgress] = useState<Partial<Record<HarnessKey, string>>>({})

  useEffect(() => {
    api.harnessMaintenance.get().then(setStatuses).catch(() => {})
    const offUpdated = onEvent(HARNESS_MAINTENANCE_UPDATED_CHANNEL, (payload) => {
      setStatuses((current) => upsert(current, payload as HarnessMaintenanceStatus[]))
    })
    const offProgress = onEvent(HARNESS_MAINTENANCE_PROGRESS_CHANNEL, (payload) => {
      const { harness, chunk } = payload as { harness: HarnessKey; chunk: string }
      setProgress((current) => ({ ...current, [harness]: ((current[harness] ?? '') + chunk).slice(-500) }))
    })
    return () => { offUpdated(); offProgress() }
  }, [])

  const handleCheckNow = useCallback(async () => {
    setChecking(true)
    try {
      const fresh = await api.harnessMaintenance.refresh(true)
      setStatuses((current) => upsert(current, fresh))
    } catch {
      // Transient — the next passive check or a retry will pick it up.
    } finally {
      setChecking(false)
    }
  }, [])

  const handleUpdate = useCallback(async (harness: HarnessKey) => {
    setUpdating(harness)
    setProgress((current) => ({ ...current, [harness]: '' }))
    try {
      const result = await api.harnessMaintenance.update(harness)
      setStatuses((current) => upsert(current, [result.newStatus]))
    } catch {
      // The error surfaces through the next status broadcast / manual refresh.
    } finally {
      setUpdating(null)
    }
  }, [])

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-foreground">Harnesses</h2>
        <button
          onClick={() => void handleCheckNow()}
          disabled={checking}
          className="text-xs text-primary hover:text-primary/80 disabled:opacity-50"
        >
          {checking ? 'Checking…' : 'Check now'}
        </button>
      </div>

      {statuses.length === 0 ? (
        <p className="text-xs text-muted-foreground">Loading harness versions…</p>
      ) : (
        <div className="space-y-2">
          {statuses.map((status) => (
            <div key={status.harness} className="rounded-lg border border-border/50 bg-card p-3 space-y-1.5" data-testid={`mobile-harness-${status.harness}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`h-2 w-2 rounded-full shrink-0 ${STATUS_DOT[status.status]}`} />
                  <span className="text-sm font-medium truncate">{harnessDisplayLabel(status.harness)}</span>
                </div>
                <span className="text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded shrink-0">
                  {status.installer === 'bundled' ? 'Updates with 20x' : STATUS_LABEL[status.status]}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {status.installed ? `v${status.version ?? '?'}` : 'Not installed'}
                {status.latestVersion && status.latestVersion !== status.version && ` · latest v${status.latestVersion}`}
              </p>
              {status.canUpdate && (
                <button
                  onClick={() => void handleUpdate(status.harness)}
                  disabled={updating === status.harness}
                  className="text-xs text-primary hover:text-primary/80 disabled:opacity-50"
                >
                  {updating === status.harness ? 'Updating…' : 'Update now'}
                </button>
              )}
              {updating === status.harness && progress[status.harness] && (
                <p className="text-[10px] text-muted-foreground/70 truncate">{progress[status.harness]}</p>
              )}
              {status.hasActiveSession && (
                <p className="text-[10px] text-muted-foreground/70">Restart running tasks to use the new version.</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
