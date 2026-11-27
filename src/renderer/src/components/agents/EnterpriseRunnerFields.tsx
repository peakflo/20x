import { useEffect, useState } from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { Label } from '@/components/ui/Label'
import { enterpriseRunnersApi } from '@/lib/ipc-client'
import {
  PERMISSION_LIMIT_TOOLTIP,
  permissionModeOptions,
  runnerHarnessLabel,
  type EnterpriseAgentRunnerInfo,
  type EnterpriseRunner,
  type RunnerPermissionMode
} from '@shared/enterprise-runners'

interface Props {
  /** Local agent row of the synced `[Workflo]` agent; null while none is selected. */
  syncedAgentId: string | null
  runnerId: string
  onRunnerId: (id: string) => void
  mode: RunnerPermissionMode | ''
  onMode: (mode: RunnerPermissionMode) => void
  /** Called with the server limit once known so the form can clamp its stored mode. */
  onLimit?: (limit: RunnerPermissionMode) => void
  onOpenInSpaces?: () => void
}

export function EnterpriseRunnerFields({ syncedAgentId, runnerId, onRunnerId, mode, onMode, onLimit, onOpenInSpaces }: Props) {
  const [info, setInfo] = useState<EnterpriseAgentRunnerInfo | null>(null)
  const [runners, setRunners] = useState<EnterpriseRunner[]>([])

  useEffect(() => {
    if (!syncedAgentId) { setInfo(null); return }
    let cancelled = false
    void enterpriseRunnersApi.getAgentInfo(syncedAgentId).then((i) => {
      if (cancelled) return
      setInfo(i)
      onLimit?.(i.permissionLimit)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [syncedAgentId])

  useEffect(() => {
    let cancelled = false
    void enterpriseRunnersApi.listRunners().then((r) => {
      if (!cancelled && r.ok) setRunners(r.runners)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  const compatible = runners.filter((r) => !info?.backend || r.harnesses.length === 0 || r.harnesses.some((h) => h.name === info.backend))
  const pinned = runners.find((r) => r.id === runnerId)
  const pinnedOffline = !!pinned && pinned.status === 'offline'
  const options = permissionModeOptions(info?.permissionLimit ?? 'bypass')

  return (
    <div className="space-y-4" data-testid="enterprise-runner-fields">
      <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <RefreshCw className="h-3 w-3" aria-hidden /> Synced · Prompt, model and tools come from the server agent. Edit in Spaces.
        </span>
        {onOpenInSpaces && (
          <button type="button" onClick={onOpenInSpaces} className="inline-flex shrink-0 items-center gap-1 text-foreground hover:underline">
            Open <ExternalLink className="h-3 w-3" aria-hidden />
          </button>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="runner-pin">Runner pin (optional)</Label>
        <select
          id="runner-pin"
          value={runnerId}
          onChange={(e) => onRunnerId(e.target.value)}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer"
        >
          <option value="">Any runner I can use{info?.backend ? ` that has ${runnerHarnessLabel(info.backend)}` : ''}</option>
          {compatible.map((r) => (
            <option key={r.id} value={r.id}>{r.name}{r.status === 'offline' ? ' — offline' : ''}</option>
          ))}
          {runnerId && !compatible.some((r) => r.id === runnerId) && <option value={runnerId}>{pinned?.name ?? runnerId}</option>}
        </select>
        {pinnedOffline && (
          <p className="text-xs text-muted-foreground" data-testid="runner-pin-offline">Pinned runner offline → the task waits instead of moving.</p>
        )}
      </div>

      <fieldset className="space-y-1.5">
        <legend className="mb-1.5 text-sm font-medium">Permission mode</legend>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Permission mode">
          {options.map((o) => (
            <label
              key={o.mode}
              title={o.tooltip ?? undefined}
              data-testid={`runner-mode-${o.mode}`}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs ${o.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-accent'} ${mode === o.mode ? 'border-primary bg-accent' : ''}`}
            >
              <input
                type="radio"
                name="runner-permission-mode"
                value={o.mode}
                checked={mode === o.mode}
                disabled={o.disabled}
                onChange={() => onMode(o.mode)}
                aria-label={o.label}
              />
              {o.label}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Modes can only be narrowed. {options.some((o) => o.disabled) ? PERMISSION_LIMIT_TOOLTIP + '.' : ''}
        </p>
      </fieldset>
      <p className="text-xs text-muted-foreground">Per-session credits / tokens only. No runner-wide limits in v1.</p>
    </div>
  )
}
