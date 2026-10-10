import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Copy, Download, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Switch'
import { SettingsSection } from '../SettingsSection'
import { useHarnessMaintenanceStore } from '@/stores/harness-maintenance-store'
import { settingsApi } from '@/lib/ipc-client'
import {
  harnessDisplayLabel,
  HARNESS_UPDATE_CHECKS_SETTING_KEY,
  type HarnessKey,
  type HarnessMaintenanceStatus,
  type HarnessMaintenanceStatusValue
} from '@shared/harness-maintenance'

/** The CLI an agent-installer `install(agentName)` call expects. Cursor has no install flow here. */
const INSTALL_AGENT_NAME: Partial<Record<HarnessKey, string>> = {
  'claude-code': 'claudeCode',
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi'
}

const STATUS_BADGE: Record<HarnessMaintenanceStatusValue, { label: string; className: string }> = {
  up_to_date: { label: 'Up to date', className: 'bg-muted text-muted-foreground' },
  behind_latest: { label: 'Update available', className: 'bg-primary/15 text-primary' },
  below_recommended: { label: 'Below recommended', className: 'bg-yellow-500/15 text-yellow-300' },
  unsupported: { label: 'Unsupported', className: 'bg-destructive/15 text-destructive' },
  not_installed: { label: 'Not installed', className: 'bg-muted text-muted-foreground' },
  unknown: { label: 'Status unknown', className: 'bg-muted text-muted-foreground' }
}

function badgeFor(status: HarnessMaintenanceStatus): { label: string; className: string } {
  if (status.installer === 'bundled' && status.installed) return { label: 'Updates with 20x', className: 'bg-muted text-muted-foreground' }
  return STATUS_BADGE[status.status]
}

function needsManualBadge(status: HarnessMaintenanceStatus): boolean {
  return status.installed && !status.canUpdate && status.installer !== 'bundled' && status.status !== 'up_to_date' && status.status !== 'unknown'
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="flex items-center gap-2 min-w-0">
      <code className="flex-1 min-w-0 truncate rounded bg-muted px-2 py-1 text-[11px]">{command}</code>
      <Button size="sm" variant="ghost" onClick={copy} aria-label="Copy update command">
        <Copy className="h-3 w-3" />
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

function InstallButton({ harness, onInstalled }: { harness: HarnessKey; onInstalled: () => void }) {
  const [installing, setInstalling] = useState(false)
  const agentName = INSTALL_AGENT_NAME[harness]
  if (!agentName) return null

  const install = async (): Promise<void> => {
    setInstalling(true)
    try {
      await window.electronAPI.agentInstaller.install(agentName)
      onInstalled()
    } finally {
      setInstalling(false)
    }
  }

  return (
    <Button size="sm" onClick={() => void install()} disabled={installing}>
      {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
      Install
    </Button>
  )
}

function HarnessRow({ status }: { status: HarnessMaintenanceStatus }) {
  const update = useHarnessMaintenanceStore((s) => s.update)
  const refresh = useHarnessMaintenanceStore((s) => s.refresh)
  const ui = useHarnessMaintenanceStore((s) => s.updates[status.harness])
  const badge = badgeFor(status)
  const name = harnessDisplayLabel(status.harness)

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 space-y-2" data-testid={`harness-row-${status.harness}`}>
      <div className="flex items-center gap-2 min-w-0 flex-wrap">
        <span className="font-medium text-sm">{name}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${badge.className}`}>{badge.label}</span>
        {needsManualBadge(status) && (
          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 bg-muted text-muted-foreground">Manual update</span>
        )}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {!status.installed ? (
            <InstallButton harness={status.harness} onInstalled={() => void refresh(true)} />
          ) : status.canUpdate ? (
            <Button
              size="sm"
              onClick={() => void update(status.harness)}
              disabled={ui?.running}
              data-testid={`harness-update-${status.harness}`}
            >
              {ui?.running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {ui?.running ? 'Updating…' : 'Update now'}
            </Button>
          ) : null}
        </div>
      </div>

      {status.installed && (
        <p className="text-xs text-muted-foreground">
          {`Installed ${status.version ?? 'unknown version'}`}
          {status.latestVersion && status.latestVersion !== status.version && ` · Latest ${status.latestVersion}`}
        </p>
      )}

      {status.installed && !status.canUpdate && status.updateCommand && (
        <CopyCommand command={status.updateCommand} />
      )}

      {ui?.running && ui.progress && (
        <pre className="text-[11px] text-muted-foreground bg-muted/50 rounded px-2 py-1.5 max-h-24 overflow-y-auto whitespace-pre-wrap" data-testid={`harness-progress-${status.harness}`}>
          {ui.progress}
        </pre>
      )}

      {ui?.run && !ui.running && (
        <p
          className={`text-xs flex items-center gap-1.5 ${ui.run.status === 'succeeded' ? 'text-primary' : ui.run.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}
          data-testid={`harness-result-${status.harness}`}
        >
          {ui.run.status === 'succeeded' ? <Check className="h-3 w-3" /> : ui.run.status === 'failed' ? <AlertTriangle className="h-3 w-3" /> : null}
          {ui.run.message}
        </p>
      )}

      {status.hasActiveSession && (
        <p className="text-[11px] text-muted-foreground">Restart running tasks to use the new version.</p>
      )}

      {status.error && <p className="text-xs text-destructive">{status.error}</p>}
    </div>
  )
}

/**
 * Settings → Harnesses: version checks and one-click updates for the harness
 * CLIs agents run on (Claude Code, Codex, OpenCode, Pi). Cursor shows as
 * "Updates with 20x" (or manual, until it moves onto `@cursor/sdk`).
 * Updates never run without this component's explicit "Update now" click.
 */
export function HarnessesSection() {
  const statuses = useHarnessMaintenanceStore((s) => s.statuses)
  const loaded = useHarnessMaintenanceStore((s) => s.loaded)
  const refreshing = useHarnessMaintenanceStore((s) => s.refreshing)
  const init = useHarnessMaintenanceStore((s) => s.init)
  const refresh = useHarnessMaintenanceStore((s) => s.refresh)
  const updateAll = useHarnessMaintenanceStore((s) => s.updateAll)
  const updates = useHarnessMaintenanceStore((s) => s.updates)

  const [checksEnabled, setChecksEnabled] = useState(true)
  const [updatingAll, setUpdatingAll] = useState(false)

  useEffect(() => init(), [init])
  useEffect(() => {
    void settingsApi.get(HARNESS_UPDATE_CHECKS_SETTING_KEY).then((v) => { if (v !== null) setChecksEnabled(v !== 'false') })
  }, [])

  const anyCanUpdate = statuses.some((s) => s.canUpdate)
  const anyRunning = Object.values(updates).some((u) => u.running)

  const handleUpdateAll = async (): Promise<void> => {
    setUpdatingAll(true)
    try {
      await updateAll()
    } finally {
      setUpdatingAll(false)
    }
  }

  return (
    <SettingsSection
      title="Harnesses"
      description="Version checks for the CLIs agents run on. 20x never updates one without this click."
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={checksEnabled}
            onCheckedChange={async (checked) => {
              setChecksEnabled(checked)
              await settingsApi.set(HARNESS_UPDATE_CHECKS_SETTING_KEY, checked ? 'true' : 'false')
            }}
          />
          Check for harness updates
        </label>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => void refresh(true)} disabled={refreshing}>
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Check now
          </Button>
          <Button size="sm" onClick={() => void handleUpdateAll()} disabled={!anyCanUpdate || updatingAll || anyRunning}>
            {updatingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {updatingAll ? 'Updating…' : 'Update all'}
          </Button>
        </div>
      </div>

      {!loaded ? (
        <p className="text-xs text-muted-foreground">Checking installed harnesses…</p>
      ) : (
        <div className="space-y-2">
          {statuses.map((status) => (
            <HarnessRow key={status.harness} status={status} />
          ))}
        </div>
      )}
    </SettingsSection>
  )
}
