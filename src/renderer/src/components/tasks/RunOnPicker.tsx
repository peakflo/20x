import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Lock, Search, Server } from 'lucide-react'
import { enterpriseRunnersApi } from '@/lib/ipc-client'
import { useEnterpriseStore } from '@/stores/enterprise-store'
import { useUIStore } from '@/stores/ui-store'
import {
  RUN_ON_LOCAL,
  runnerDisabledReason,
  runnerHarnessLabel,
  sectionRunners,
  type EnterpriseAgentRunnerInfo,
  type EnterpriseRunner,
  type RunOnChoice,
  type RunnersResult
} from '@shared/enterprise-runners'

interface RunOnPickerProps {
  /** Persisted choice for an existing task. Omit for a not-yet-created task and use `value`/`onChange`. */
  taskId?: string
  /** `[Workflo]` agent selected for the task (drives harness checks and the pin). */
  agentId?: string | null
  /** The task already has a session: the choice is fixed. */
  sessionStarted?: boolean
  value?: RunOnChoice
  onChange?: (choice: RunOnChoice) => void
  /** Popover side; the composer anchors above, the header below. */
  placement?: 'above' | 'below'
  className?: string
}

const DOT: Record<EnterpriseRunner['status'], string> = {
  online: 'bg-emerald-500',
  busy: 'bg-amber-500',
  offline: 'bg-muted-foreground/40',
  refused: 'bg-destructive'
}

const DOT_LABEL: Record<EnterpriseRunner['status'], string> = {
  online: 'Online',
  busy: 'Busy',
  offline: 'Offline',
  refused: 'Refused'
}

function chipLabel(choice: RunOnChoice): string {
  return choice.kind === 'local' ? 'This Mac' : choice.runnerName
}

export function RunOnPicker({ taskId, agentId, sessionStarted = false, value, onChange, placement = 'above', className }: RunOnPickerProps) {
  const signedIn = useEnterpriseStore((s) => s.isAuthenticated)
  const openSettings = useUIStore((s) => s.openSettings)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [localChoice, setLocalChoice] = useState<RunOnChoice>(value ?? RUN_ON_LOCAL)
  const [locked, setLocked] = useState(sessionStarted)
  const [runners, setRunners] = useState<RunnersResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [agentInfo, setAgentInfo] = useState<EnterpriseAgentRunnerInfo | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const choice = value ?? localChoice

  useEffect(() => { setLocked(sessionStarted) }, [sessionStarted])

  useEffect(() => {
    if (!signedIn || !taskId) return
    let cancelled = false
    void enterpriseRunnersApi.getTaskRunOn(taskId).then((r) => {
      if (cancelled) return
      setLocalChoice(r.choice)
      setLocked((l) => l || r.locked)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [signedIn, taskId])

  useEffect(() => {
    if (!signedIn || !agentId) { setAgentInfo(null); return }
    let cancelled = false
    void enterpriseRunnersApi.getAgentInfo(agentId).then((info) => { if (!cancelled) setAgentInfo(info) }).catch(() => { if (!cancelled) setAgentInfo(null) })
    return () => { cancelled = true }
  }, [signedIn, agentId])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRunners(await enterpriseRunnersApi.listRunners())
    } catch (err) {
      setRunners({ ok: false, error: err instanceof Error ? err.message : String(err), code: 'unknown' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (open && signedIn) void load() }, [open, signedIn, load])

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])

  const forbidden = runners?.ok === false && runners.code === 'forbidden'
  const sections = useMemo(
    () => (runners?.ok ? sectionRunners(runners.runners, query) : { mine: [], shared: [] }),
    [runners, query]
  )

  if (!signedIn) return null
  // An agent with no Spaces counterpart can only run on this Mac: nothing to choose.
  if (agentInfo && !agentInfo.enterpriseAgentId && !agentInfo.runnerOnly) return null
  const runnerOnly = agentInfo?.runnerOnly === true

  if (locked) {
    return (
      <div className={className} data-testid="run-on-locked">
        <span
          className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground"
          title="Chosen when the task started. To use another runner, start a new session there."
        >
          <Lock className="h-3 w-3" aria-hidden />
          <span>Locked to {chipLabel(choice)}</span>
        </span>
      </div>
    )
  }

  const select = async (next: RunOnChoice): Promise<void> => {
    setOpen(false)
    setLocalChoice(next)
    onChange?.(next)
    if (taskId) {
      try {
        const r = await enterpriseRunnersApi.setTaskRunOn(taskId, next)
        setLocalChoice(r.choice)
        if (r.locked) setLocked(true)
      } catch {
        /* a locked task rejects the change; the chip re-syncs on next load */
      }
    }
  }

  const reasonFor = (runner: EnterpriseRunner): string | null =>
    runnerDisabledReason(runner, {
      signedIn,
      hasPermission: !forbidden,
      agentBackend: agentInfo?.backend ?? null,
      agentPinnedRunnerId: agentInfo?.runnerPin ?? null
    })

  const renderRunner = (runner: EnterpriseRunner): React.JSX.Element => {
    const reason = reasonFor(runner)
    const selected = choice.kind === 'runner' && choice.runnerId === runner.id
    return (
      <button
        key={runner.id}
        type="button"
        role="option"
        aria-selected={selected}
        aria-disabled={!!reason}
        disabled={!!reason}
        data-testid={`run-on-runner-${runner.id}`}
        onClick={() => void select({ kind: 'runner', runnerId: runner.id, runnerName: runner.name })}
        className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
      >
        <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${DOT[runner.status]}`} title={DOT_LABEL[runner.status]} aria-label={DOT_LABEL[runner.status]} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-medium text-foreground">{runner.name}</span>
            {runner.harnesses.map((h) => (
              <span key={h.name} className="rounded border bg-muted/50 px-1 py-px text-[10px] text-muted-foreground">{runnerHarnessLabel(h.name)}</span>
            ))}
            {runner.activeSessionCount > 0 && <span className="text-[10px] text-muted-foreground">{runner.activeSessionCount} running</span>}
          </span>
          {reason && <span className="mt-0.5 block text-[11px] text-muted-foreground" data-testid={`run-on-reason-${runner.id}`}>{reason}</span>}
        </span>
        {selected && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />}
      </button>
    )
  }

  const error = runners && !runners.ok ? runners : null

  return (
    <div ref={rootRef} className={`relative inline-block ${className ?? ''}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="run-on-chip"
        className="inline-flex items-center gap-1.5 rounded-full border bg-background/60 px-2.5 py-1 text-xs text-foreground hover:bg-accent"
      >
        <Server className="h-3 w-3 text-muted-foreground" aria-hidden />
        <span className="text-muted-foreground">Run on:</span>
        <span className="font-medium">{runnerOnly && choice.kind === 'local' ? 'Choose a runner' : chipLabel(choice)}</span>
        <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Run on"
          data-testid="run-on-popover"
          className={`absolute left-0 z-50 flex max-h-[min(34rem,70vh)] w-[26rem] max-w-[calc(100vw-2rem)] flex-col ${placement === 'above' ? 'bottom-full mb-2' : 'top-full mt-2'} overflow-hidden rounded-lg glass-popover border p-1 shadow-xl`}
        >
          <div className="flex shrink-0 items-center gap-2 border-b px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search machines and harnesses"
              aria-label="Search runners"
              className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            <button
              type="button"
              role="option"
              aria-selected={choice.kind === 'local'}
              data-testid="run-on-local"
              disabled={runnerOnly}
              onClick={() => void select(RUN_ON_LOCAL)}
              className={`flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left text-xs hover:bg-accent ${runnerOnly ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="font-medium text-foreground">This Mac</span>
                  <span className="rounded border bg-muted/50 px-1 py-px text-[10px] text-muted-foreground">local</span>
                </span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">{runnerOnly ? 'This agent runs on a runner only' : 'Local worktree · not synced to Spaces'}</span>
              </span>
              {choice.kind === 'local' && !runnerOnly && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />}
            </button>

            {loading && !runners && (
              <p className="px-2.5 py-3 text-xs text-muted-foreground" data-testid="run-on-loading">Loading runners from Spaces…</p>
            )}
            {error && (
              <div className="px-2.5 py-3 text-xs" data-testid="run-on-error">
                {error.code === 'signed-out' ? (
                  <>
                    <p className="text-muted-foreground">Sign in to Peakflo Enterprise to use runners</p>
                    <button type="button" onClick={() => { setOpen(false); openSettings() }} className="mt-1.5 rounded border px-2 py-0.5 hover:bg-accent">Sign in…</button>
                  </>
                ) : error.code === 'forbidden' ? (
                  <p className="text-muted-foreground">Permission denied · needs coding-agents:use</p>
                ) : (
                  <>
                    <p className="font-medium text-foreground">Couldn’t load runners</p>
                    <p className="mt-0.5 text-muted-foreground">{error.error}. Local runs still work.</p>
                    <button type="button" onClick={() => void load()} className="mt-1.5 rounded border px-2 py-0.5 hover:bg-accent">Retry</button>
                  </>
                )}
              </div>
            )}
            {runners?.ok && (
              <>
                <p className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">My machines · {sections.mine.length}</p>
                {sections.mine.length === 0 && <p className="px-2.5 py-1 text-[11px] text-muted-foreground">No machines. Connect one in Settings → Machines.</p>}
                {sections.mine.map(renderRunner)}
                <p className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Shared runners · {sections.shared.length}</p>
                {sections.shared.length === 0 && <p className="px-2.5 py-1 text-[11px] text-muted-foreground">No shared runners.</p>}
                {sections.shared.map(renderRunner)}
              </>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 border-t px-2.5 py-1.5 text-[11px] text-muted-foreground">
            <button type="button" className="hover:text-foreground" onClick={() => { setOpen(false); openSettings() }}>⚙ Manage machines…</button>
            <span>Not “This Mac” = synced to Spaces</span>
          </div>
        </div>
      )}
    </div>
  )
}
