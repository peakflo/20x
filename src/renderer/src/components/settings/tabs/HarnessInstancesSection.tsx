import { useEffect, useRef, useState } from 'react'
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { SettingsSection } from '../SettingsSection'
import { AddAccountDialog } from './AddAccountDialog'
import { harnessInstanceApi } from '@/lib/ipc-client'
import { useHarnessInstanceStore } from '@/stores/harness-instance-store'
import {
  harnessInstanceDisplayName,
  harnessTypeLabel,
  signInCommand,
  type HarnessInstanceView
} from '@shared/harness-instances'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** One copyable sign-in command, quoted for the chosen shell. */
function SignInCommand({ shell, command }: { shell: string; command: string }) {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-[11px] text-muted-foreground w-20 shrink-0">{shell}</span>
      <code className="flex-1 min-w-0 truncate rounded bg-muted px-2 py-1 text-[11px]">{command}</code>
      <Button size="sm" variant="ghost" onClick={copy} aria-label={`Copy ${shell} sign-in command`}>
        <Copy className="h-3 w-3" />
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

function InstanceRow({
  instance,
  onChanged,
  highlighted
}: {
  instance: HarnessInstanceView
  onChanged: () => void
  highlighted?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(instance.label)
  const [error, setError] = useState<string | null>(null)
  const name = harnessInstanceDisplayName(instance.harness_type, instance.label)
  const rowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (highlighted) {
      rowRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
    }
  }, [highlighted])

  const save = async (): Promise<void> => {
    setError(null)
    try {
      await harnessInstanceApi.update(instance.id, { label })
      setEditing(false)
      onChanged()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const remove = async (): Promise<void> => {
    setError(null)
    try {
      await harnessInstanceApi.delete(instance.id)
      onChanged()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <div
      ref={rowRef}
      className={`rounded-lg border px-4 py-3 space-y-2 transition-colors ${
        highlighted ? 'border-primary ring-2 ring-primary/40 bg-primary/5' : 'border-border bg-card'
      }`}
      data-testid={`harness-instance-${instance.id}`}
      {...(highlighted ? { 'data-highlighted': 'true' } : {})}
    >
      <div className="flex items-center gap-2 min-w-0">
        {editing ? (
          <>
            <Input
              aria-label="Account name"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="h-7 text-sm"
            />
            <Button size="sm" onClick={() => void save()} disabled={!label.trim()}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setLabel(instance.label) }}>Cancel</Button>
          </>
        ) : (
          <>
            <span className="font-medium text-sm truncate">{name}</span>
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
                instance.shares_history ? 'bg-muted text-muted-foreground' : 'bg-yellow-500/15 text-yellow-300'
              }`}
              data-testid="harness-instance-sharing"
            >
              {instance.shares_history ? 'Tasks continue natively' : 'Context is carried over'}
            </span>
            <div className="ml-auto flex items-center gap-1 shrink-0">
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)} aria-label={`Rename ${name}`}>
                <Pencil className="h-3 w-3" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void remove()} aria-label={`Remove ${name}`}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          </>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground font-mono break-all">{instance.home_path}</p>
      <div className="space-y-1">
        <SignInCommand shell="POSIX shell" command={signInCommand(instance.harness_type, instance.home_path, 'posix')} />
        <SignInCommand shell="PowerShell" command={signInCommand(instance.harness_type, instance.home_path, 'powershell')} />
      </div>
      {!instance.shares_history && (
        <p className="text-[11px] text-muted-foreground">
          This folder keeps its own session files, so a task moved to or from this account is continued by a handoff, not natively.
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

/**
 * Settings → Harnesses: subscription logins ("Codex · Work", "Claude Code · Personal").
 * Each login has its own home folder. 20x never runs the sign-in itself; it shows
 * the command to run in a terminal.
 */
export function HarnessInstancesSection() {
  const instances = useHarnessInstanceStore((s) => s.instances)
  const load = useHarnessInstanceStore((s) => s.load)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [highlightId, setHighlightId] = useState<string | null>(null)

  useEffect(() => { void load() }, [load])

  // Clear the highlight after a bit so it reads as a one-time "just added" cue.
  useEffect(() => {
    if (!highlightId) return
    const timeout = setTimeout(() => setHighlightId(null), 2500)
    return () => clearTimeout(timeout)
  }, [highlightId])

  const handleCreated = (created: HarnessInstanceView): void => {
    void load()
    setHighlightId(created.id)
  }

  return (
    <SettingsSection
      title="Accounts"
      description="Subscription logins of Claude Code and Codex. An agent picks one of these in its harness dropdown. Sign in once per account with the command shown."
    >
      <div className="flex items-center justify-end">
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          Add account
        </Button>
      </div>
      <div className="space-y-3">
        {instances.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No extra accounts. Agents use the default {harnessTypeLabel('claude-code')} and {harnessTypeLabel('codex')} logins.
          </p>
        )}
        {instances.map((instance) => (
          <InstanceRow
            key={instance.id}
            instance={instance}
            onChanged={() => void load()}
            highlighted={instance.id === highlightId}
          />
        ))}
      </div>

      <AddAccountDialog open={dialogOpen} onOpenChange={setDialogOpen} onCreated={handleCreated} />
    </SettingsSection>
  )
}
