import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, CheckCircle2, CircleDashed, ExternalLink, Loader2, ShieldCheck, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog'
import { cn } from '@/lib/utils'
import { enterpriseRunnersApi } from '@/lib/ipc-client'
import { useConnectComputerStore } from '@/stores/connect-computer-store'
import { useMachinesStore } from '@/stores/machines-store'
import { useUIStore } from '@/stores/ui-store'
import { SettingsTab } from '@/types'
import {
  CONNECT_STEPS,
  CONNECT_VENDOR_LABELS,
  CONNECT_VENDORS,
  previewConnectCommand,
  type ConnectFailure,
  type ConnectProgress,
  type ConnectStepState,
  type HarnessChoice,
  type PreflightResult
} from '@shared/enterprise-runners'

const CHOICES: { value: HarnessChoice; label: string }[] = [
  { value: 'all', label: 'All detected' },
  ...CONNECT_VENDORS.map((v) => ({ value: v as HarnessChoice, label: CONNECT_VENDOR_LABELS[v] }))
]

function StepIcon({ state }: { state: ConnectStepState }) {
  if (state === 'done') return <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden />
  if (state === 'active') return <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden />
  if (state === 'failed') return <XCircle className="h-4 w-4 text-red-500" aria-hidden />
  return <CircleDashed className="h-4 w-4 text-muted-foreground/50" aria-hidden />
}

export function Stepper({ steps }: { steps: ConnectProgress['steps'] }) {
  return (
    <ol className="flex items-center gap-3 text-sm" aria-label="Connection progress">
      {CONNECT_STEPS.map((step, index) => (
        <li key={step.id} className="flex items-center gap-2" data-step={step.id} data-state={steps[step.id]}>
          <StepIcon state={steps[step.id]} />
          <span className={cn(steps[step.id] === 'pending' && 'text-muted-foreground')}>{step.label}</span>
          {index < CONNECT_STEPS.length - 1 && <span className="mx-1 h-px w-6 bg-border" aria-hidden />}
        </li>
      ))}
    </ol>
  )
}

function CheckRow({ ok, detail, help }: { ok: boolean; detail: string; help?: string }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {ok ? <Check className="mt-0.5 h-4 w-4 text-emerald-500" aria-hidden /> : <XCircle className="mt-0.5 h-4 w-4 text-red-500" aria-hidden />}
      <div>
        <span className={cn(!ok && 'text-red-400')}>{detail}</span>
        {!ok && help && <div className="font-mono text-xs text-muted-foreground">{help}</div>}
      </div>
    </li>
  )
}

export function FailurePanel({
  failure,
  onRetry,
  onRecheck
}: {
  failure: ConnectFailure
  onRetry: () => void
  onRecheck: () => void
}) {
  const titles: Record<ConnectFailure['kind'], string> = {
    unsupported_os: "Windows isn't supported",
    not_signed_in: 'Sign in to Peakflo Enterprise',
    permission_denied: 'Permission denied',
    version_unavailable: 'No harness version available',
    node_missing: 'Missing requirements',
    git_missing: 'Missing requirements',
    denied: 'Not connected',
    expired: 'Cannot connect',
    service_failed: "Registered, but the service didn't start",
    vendor_missing: 'Harness not ready',
    rate_limited: 'Too many attempts',
    cancelled_partial: 'Cancelled — may be partly set up',
    unknown: 'Connection failed'
  }
  const recheck = failure.kind === 'node_missing' || failure.kind === 'git_missing' || failure.kind === 'version_unavailable'
  return (
    <div role="alert" className="space-y-3 rounded-xl border border-red-500/30 bg-red-500/5 p-4" data-failure={failure.kind}>
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
        <div className="space-y-1 text-sm">
          <div className="font-medium">{titles[failure.kind]}</div>
          <p className="text-muted-foreground">{failure.message}</p>
          {failure.kind === 'service_failed' && failure.logPath && (
            <p className="text-muted-foreground">
              The machine shows as Offline. Service log: <code className="font-mono text-xs">{failure.logPath}</code>
            </p>
          )}
          {failure.help && <code className="block select-all rounded-md bg-muted px-2 py-1 font-mono text-xs">{failure.help}</code>}
          {failure.kind === 'expired' && (
            <p className="text-muted-foreground">Check that you are signed in as the person who started this, in the same company.</p>
          )}
        </div>
      </div>
      {failure.kind !== 'unsupported_os' && failure.kind !== 'not_signed_in' && failure.kind !== 'permission_denied' && (
        <div className="flex gap-2">
          {recheck ? (
            <Button size="sm" onClick={onRecheck}>Re-check</Button>
          ) : (
            <Button size="sm" onClick={onRetry}>
              {failure.kind === 'expired' ? 'Get a new connection' : failure.kind === 'service_failed' ? 'Retry service install' : 'Try again'}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

export function ConnectComputerModal() {
  const { open, replacesRunnerId, replacesName, close } = useConnectComputerStore()
  const refreshMachines = useMachinesStore((s) => s.refresh)

  const [preflight, setPreflight] = useState<PreflightResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [choice, setChoice] = useState<HarnessChoice>('all')
  const [ask, setAsk] = useState(false)
  const [starting, setStarting] = useState(false)
  const [startFailure, setStartFailure] = useState<ConnectFailure | null>(null)
  const [progress, setProgress] = useState<ConnectProgress | null>(null)
  const [showLog, setShowLog] = useState(false)
  const runIdRef = useRef<string | null>(null)

  const runPreflight = useCallback(async () => {
    setChecking(true)
    try {
      setPreflight(await enterpriseRunnersApi.preflight())
    } catch (error) {
      setPreflight(null)
      setStartFailure({ kind: 'unknown', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setChecking(false)
    }
  }, [])

  // Reset and check every time the modal opens. If a run is already going
  // (the modal was closed mid-way), pick it back up.
  useEffect(() => {
    if (!open) return
    setStartFailure(null)
    setChoice('all')
    setAsk(false)
    setShowLog(false)
    void enterpriseRunnersApi.connectProgress().then((existing) => {
      if (existing && existing.phase === 'running') {
        runIdRef.current = existing.runId
        setProgress(existing)
      } else {
        runIdRef.current = null
        setProgress(null)
        void runPreflight()
      }
    })
  }, [open, runPreflight])

  useEffect(() => {
    if (!open) return
    return enterpriseRunnersApi.onConnectProgress((next) => {
      if (runIdRef.current && next.runId !== runIdRef.current) return
      runIdRef.current = next.runId
      setProgress(next)
      if (next.phase === 'success') void refreshMachines({ quiet: true })
    })
  }, [open, refreshMachines])

  const start = useCallback(async () => {
    setStarting(true)
    setStartFailure(null)
    try {
      const result = await enterpriseRunnersApi.connectStart({
        vendor: choice,
        ask: choice === 'all' && ask,
        ...(replacesRunnerId ? { replacesRunnerId } : {})
      })
      if (!result.ok) setStartFailure(result.failure)
      else runIdRef.current = result.runId
    } finally {
      setStarting(false)
    }
  }, [choice, ask, replacesRunnerId])

  const retry = useCallback(() => {
    runIdRef.current = null
    setProgress(null)
    setStartFailure(null)
    void runPreflight()
  }, [runPreflight])

  // Once register or service has started, Esc / an outside click must not
  // cancel the run: only the explicit Cancel button does.
  const pastPointOfNoReturn =
    progress?.phase === 'running' && (progress.steps.register !== 'pending' || progress.steps.service !== 'pending')

  const cancelAndClose = useCallback(() => {
    if (progress?.phase === 'running') void enterpriseRunnersApi.connectCancel(progress.runId)
    close()
  }, [progress, close])

  const cancelRun = useCallback(() => {
    if (progress?.phase === 'running') void enterpriseRunnersApi.connectCancel(progress.runId)
  }, [progress])

  const viewInMachines = useCallback(() => {
    useUIStore.getState().setSettingsTab(SettingsTab.MACHINES)
    useUIStore.getState().openSettings()
    close()
  }, [close])

  let preview: string | null = null
  if (preflight?.pinnedVersion && preflight.controlPlane) {
    try {
      preview = previewConnectCommand({
        version: preflight.pinnedVersion,
        vendor: choice === 'all' ? null : choice,
        controlPlane: preflight.controlPlane,
        ask: choice === 'all' && ask
      })
    } catch {
      preview = null
    }
  }

  const running = progress?.phase === 'running'
  const unsupported = preflight?.failure?.kind === 'unsupported_os'
  const failure = progress?.phase === 'failed' || progress?.phase === 'cancelled' ? progress.failure : startFailure
  const canStart = preflight?.ok === true && !starting && !running && !checking

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !pastPointOfNoReturn) cancelAndClose() }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{replacesName ? `Reconnect ${replacesName}` : 'Connect this computer'}</DialogTitle>
          <DialogDescription>
            20x runs the published harness at the version your server requires, so it always matches. macOS and Linux only.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-4">
            {progress?.phase === 'success' ? (
              <div className="space-y-3" data-testid="connect-success">
                <Stepper steps={progress.steps} />
                <div className="flex items-start gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm">
                  <ShieldCheck className="mt-0.5 h-4 w-4 text-emerald-500" />
                  <div>
                    <div className="font-medium">{progress.machineName ?? 'This computer'} is connected</div>
                    <p className="text-muted-foreground">
                      Background service running
                      {progress.harnessesConnected.length > 0 ? ` · ${progress.harnessesConnected.join(', ')}` : ''}
                      {progress.company ? ` · ${progress.company}` : ''}. It now appears in Machines and in the Run-on picker.
                    </p>
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={close}>Done</Button>
                  <Button onClick={viewInMachines}>View in Machines</Button>
                </div>
              </div>
            ) : progress ? (
              <div className="space-y-3">
                <Stepper steps={progress.steps} />
                {running && progress.steps.approve === 'active' && (
                  <div className="space-y-2 rounded-xl border border-border/60 p-4 text-sm" data-testid="approve-card">
                    <div className="font-medium">Approve in your browser</div>
                    <p className="text-muted-foreground">
                      We opened the approval page. The command is waiting. Only continue if you just started this connection.
                    </p>
                    {progress.approveUrl && <code className="block break-all font-mono text-xs text-muted-foreground">{progress.approveUrl}</code>}
                    <Button size="sm" variant="secondary" onClick={() => void enterpriseRunnersApi.openApproval(progress.runId)}>
                      <ExternalLink className="h-3.5 w-3.5" /> Open the page again
                    </Button>
                  </div>
                )}
                {running && progress.steps.approve !== 'active' && (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Working…
                  </p>
                )}
                {failure && <FailurePanel failure={failure} onRetry={retry} onRecheck={retry} />}
                <div>
                  <button className="text-xs text-muted-foreground underline" onClick={() => setShowLog((v) => !v)}>
                    {showLog ? 'Hide output' : 'Show output'}
                  </button>
                  {showLog && (
                    <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px]" data-testid="connect-log">
                      {progress.commandDisplay}
                      {'\n'}
                      {progress.lines.join('\n')}
                    </pre>
                  )}
                </div>
                {running && (
                  <div className="flex justify-end">
                    <Button variant="ghost" onClick={cancelRun}>Cancel</Button>
                  </div>
                )}
              </div>
            ) : (
              <>
                <section aria-label="Pre-install check">
                  <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Pre-install check</h4>
                  {checking && !preflight ? (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Checking this computer…</p>
                  ) : (
                    <ul className="space-y-1">
                      {preflight?.checks.map((c) => <CheckRow key={c.id} ok={c.ok} detail={c.detail} help={c.help} />)}
                    </ul>
                  )}
                </section>

                {unsupported ? (
                  <FailurePanel failure={preflight!.failure!} onRetry={retry} onRecheck={retry} />
                ) : (
                  <>
                    <section aria-label="Harnesses" className="space-y-2">
                      <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Harnesses</h4>
                      <div role="radiogroup" aria-label="Harnesses" className="flex flex-wrap gap-2">
                        {CHOICES.map((c) => (
                          <button
                            key={c.value}
                            role="radio"
                            aria-checked={choice === c.value}
                            onClick={() => { setChoice(c.value); if (c.value !== 'all') setAsk(false) }}
                            className={cn(
                              'rounded-lg border px-3 py-1.5 text-sm transition-colors',
                              choice === c.value ? 'border-primary bg-primary/10 text-foreground' : 'border-border hover:bg-accent'
                            )}
                          >
                            {c.label}
                          </button>
                        ))}
                      </div>
                      <label className={cn('flex items-start gap-2 text-sm', choice !== 'all' && 'opacity-50')}>
                        <input
                          type="checkbox"
                          checked={choice === 'all' && ask}
                          disabled={choice !== 'all'}
                          onChange={(e) => setAsk(e.target.checked)}
                          className="mt-1"
                        />
                        <span>
                          Ask before actions <code className="font-mono text-xs">(--ask)</code>
                          <span className="block text-xs text-muted-foreground">Only applies to “All detected”.</span>
                        </span>
                      </label>
                    </section>

                    {preview && (
                      <section aria-label="Command preview" className="space-y-1">
                        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">20x will run (version pinned by the server)</h4>
                        <code className="block select-all break-all rounded-md bg-muted px-3 py-2 font-mono text-xs" data-testid="command-preview">$ {preview}</code>
                        <p className="text-xs text-muted-foreground">
                          The command carries only a one-time connection id (a UUID) — no token. After you approve in the browser, the
                          machine&apos;s credential is exchanged directly and stored on this computer. With no vendor, every usable harness
                          is connected.
                        </p>
                      </section>
                    )}
                    {failure && <FailurePanel failure={failure} onRetry={retry} onRecheck={retry} />}
                    {preflight && !preflight.ok && !failure && preflight.failure && (
                      <FailurePanel failure={preflight.failure} onRetry={retry} onRecheck={retry} />
                    )}
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" onClick={cancelAndClose}>Cancel</Button>
                      <Button onClick={() => void start()} disabled={!canStart}>
                        {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Connect
                      </Button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
