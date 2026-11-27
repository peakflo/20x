import { useState } from 'react'
import { ArrowUpRight, Cloud, Loader2, Pause, Pencil, ServerCog, TriangleAlert, CheckCircle2, RefreshCw } from 'lucide-react'
import { remoteSyncLabel, runnerHarnessLabel, type EnterpriseRunner, type RemoteTaskState } from '@shared/enterprise-runners'
import { enterpriseRunnersApi } from '@/lib/ipc-client'
import { useUIStore } from '@/stores/ui-store'
import { SettingsTab } from '@/types'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

export function openInSpaces(url: string | null | undefined): void {
  if (url) void window.electronAPI.shell.openExternal(url)
}

export function formatSyncedAgo(ts: number | null, now = Date.now()): string {
  if (!ts) return 'never'
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}

/** `⛁ studio-mac · Claude Code` */
export function RunnerChip({ state, showHarness = false, className }: { state: RemoteTaskState; showHarness?: boolean; className?: string }) {
  if (!state.runnerName) return null
  return (
    <span data-testid="runner-chip" className={cn('inline-flex max-w-60 shrink-0 items-center gap-1 rounded-full border border-border/50 bg-card px-2 py-0.5 text-[11px] text-muted-foreground', className)} title={`Runs on ${state.runnerName}`}>
      <ServerCog className="h-3 w-3 shrink-0" />
      <span className="truncate">{state.runnerName}{showHarness && state.harness ? ` · ${runnerHarnessLabel(state.harness)}` : ''}</span>
      {state.sync === 'runner-offline' && <span className="shrink-0 text-amber-500">offline</span>}
    </span>
  )
}

export function SyncBadge({ state, now }: { state: RemoteTaskState; now?: number }) {
  const tone = state.sync === 'live' ? 'text-emerald-500' : state.sync === 'completed-on-spaces' ? 'text-violet-500' : 'text-amber-500'
  return (
    <span data-testid="sync-badge" className={cn('inline-flex shrink-0 items-center gap-1 text-[11px]', tone)} title={`Last synced ${formatSyncedAgo(state.lastSyncedAt, now)}`}>
      <RefreshCw className="h-3 w-3" />
      {remoteSyncLabel(state.sync)}{state.sync === 'live' ? ` · ${formatSyncedAgo(state.lastSyncedAt, now)}` : ''}
    </span>
  )
}

/** Small runner picker used by "Reassign". */
export function ReassignPicker({ taskId, currentRunnerId, onDone }: { taskId: string; currentRunnerId: string | null; onDone: () => void }) {
  const [runners, setRunners] = useState<EnterpriseRunner[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  if (runners === null && !error) {
    void enterpriseRunnersApi.listRunners().then((r) => (r.ok ? setRunners(r.runners) : setError(r.error))).catch((e) => setError(String(e)))
  }
  const choose = async (id: string): Promise<void> => {
    setBusy(id)
    const res = await enterpriseRunnersApi.reassign(taskId, id)
    setBusy(null)
    if (res.ok) onDone()
    else setError(res.error ?? 'Could not reassign')
  }
  return (
    <div role="menu" aria-label="Reassign to a runner" className="w-64 rounded-lg border bg-popover p-1 text-xs shadow-xl">
      {runners === null && !error && <div className="flex items-center gap-2 px-2 py-2 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading runners…</div>}
      {error && <div className="px-2 py-2 text-red-400">{error}</div>}
      {runners?.filter((r) => r.id !== currentRunnerId).map((r) => (
        <button key={r.id} type="button" role="menuitem" disabled={!r.selectable || busy !== null} onClick={() => void choose(r.id)} className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left hover:bg-accent disabled:opacity-50">
          <span className="truncate">{r.name}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{busy === r.id ? 'Moving…' : r.selectable ? r.status : (r.serverReason ?? r.status)}</span>
        </button>
      ))}
      {runners && runners.filter((r) => r.id !== currentRunnerId).length === 0 && <div className="px-2 py-2 text-muted-foreground">No other runners available.</div>}
      <div className="px-2 pb-1 pt-1 text-[10px] text-muted-foreground">Context is handed off to the new runner (or the task restarts there).</div>
    </div>
  )
}

/** Banner under the header for every non-live sync state. Renders nothing when live. */
export function RemoteStateBanner({ taskId, state }: { taskId: string; state: RemoteTaskState }) {
  const [picking, setPicking] = useState(false)
  const openSettings = (): void => {
    useUIStore.getState().setSettingsTab(SettingsTab.ENTERPRISE)
    useUIStore.getState().openSettings()
  }
  const base = 'relative flex items-center gap-2 border-b px-4 py-2 text-xs'
  switch (state.sync) {
    case 'runner-offline':
      return (
        <div role="status" data-testid="remote-banner-offline" className={cn(base, 'border-amber-500/30 bg-amber-500/10')}>
          <Pause className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span className="min-w-0 flex-1"><strong>Runner offline</strong> — {state.runnerName ?? 'the runner'} is not responding. Your message is queued and will continue when it’s back.</span>
          <div className="relative shrink-0">
            <Button size="sm" variant="outline" onClick={() => setPicking((p) => !p)}>Reassign to another runner</Button>
            {picking && <div className="absolute right-0 top-9 z-50"><ReassignPicker taskId={taskId} currentRunnerId={state.runnerId} onDone={() => setPicking(false)} /></div>}
          </div>
        </div>
      )
    case 'edited-on-web':
      return (
        <div role="status" data-testid="remote-banner-web" className={cn(base, 'border-sky-500/30 bg-sky-500/10')}>
          <Pencil className="h-3.5 w-3.5 shrink-0 text-sky-500" />
          <span><strong>Also open on web</strong> — {state.editedOnWebBy ?? 'Someone'} is active in Spaces. Both messages are sent; the server orders them and the agent sees both.</span>
        </div>
      )
    case 'completed-on-spaces':
      return (
        <div role="status" data-testid="remote-banner-completed" className={cn(base, 'border-violet-500/30 bg-violet-500/10')}>
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-violet-500" />
          <span className="min-w-0 flex-1"><strong>Completed on Spaces</strong>{state.completedBy ? ` by ${state.completedBy}` : ''}{state.completedAt ? ` · ${formatSyncedAgo(state.completedAt)}` : ''}. 20x doesn’t complete synced tasks locally.</span>
          {state.webUrl && <Button size="sm" variant="outline" onClick={() => openInSpaces(state.webUrl)}>Reopen on Spaces <ArrowUpRight className="h-3 w-3" /></Button>}
        </div>
      )
    case 'sync-paused':
      return (
        <div role="alert" data-testid="remote-banner-paused" className={cn(base, 'border-amber-500/30 bg-amber-500/10')}>
          <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span className="min-w-0 flex-1"><strong>Sync paused</strong> — enterprise session expired. Showing state from {formatSyncedAgo(state.lastSyncedAt)}.</span>
          <Button size="sm" variant="outline" onClick={openSettings}>Sign in again</Button>
        </div>
      )
    case 'connecting':
      return (
        <div role="status" className={cn(base, 'border-border/50 bg-muted/40 text-muted-foreground')}>
          <Cloud className="h-3.5 w-3.5 shrink-0" />Connecting to Spaces…
        </div>
      )
    default:
      return null
  }
}

/** Header cluster: runner chip, sync badge, Open in Spaces. */
export function RemoteHeaderCluster({ state }: { state: RemoteTaskState }) {
  return (
    <div className="flex shrink-0 items-center gap-2" data-testid="remote-header-cluster">
      <RunnerChip state={state} showHarness />
      <SyncBadge state={state} />
      {state.webUrl && (
        <button type="button" onClick={() => openInSpaces(state.webUrl)} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
          <ArrowUpRight className="h-3 w-3" />Open in Spaces
        </button>
      )}
    </div>
  )
}
