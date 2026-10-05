import { useEffect, useState } from 'react'
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { SettingsSection } from '../SettingsSection'
import { harnessInstanceApi } from '@/lib/ipc-client'
import { useHarnessInstanceStore } from '@/stores/harness-instance-store'
import {
  harnessInstanceDisplayName,
  harnessTypeLabel,
  signInCommand,
  type HarnessInstanceView,
  type HarnessType
} from '@shared/harness-instances'

const HARNESS_OPTIONS: Array<{ value: HarnessType; label: string }> = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' }
]

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

function InstanceRow({ instance, onChanged }: { instance: HarnessInstanceView; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(instance.label)
  const [error, setError] = useState<string | null>(null)
  const name = harnessInstanceDisplayName(instance.harness_type, instance.label)

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
    <div className="rounded-lg border border-border bg-card px-4 py-3 space-y-2" data-testid={`harness-instance-${instance.id}`}>
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
 * Settings → Agents: subscription logins ("Codex · Work", "Claude Code · Personal").
 * Each login has its own home folder. 20x never runs the sign-in itself; it shows
 * the command to run in a terminal.
 */
export function HarnessInstancesSection() {
  const instances = useHarnessInstanceStore((s) => s.instances)
  const load = useHarnessInstanceStore((s) => s.load)
  const [harness, setHarness] = useState<HarnessType>('codex')
  const [label, setLabel] = useState('')
  const [homePath, setHomePath] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void load() }, [load])

  const add = async (): Promise<void> => {
    setError(null)
    setAdding(true)
    try {
      await harnessInstanceApi.create({ harness_type: harness, label, home_path: homePath })
      setLabel('')
      setHomePath('')
      await load()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setAdding(false)
    }
  }

  return (
    <SettingsSection
      title="Accounts"
      description="Subscription logins of Claude Code and Codex. An agent picks one of these in its harness dropdown. Sign in once per account with the command shown."
    >
      <div className="space-y-3">
        {instances.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No extra accounts. Agents use the default {harnessTypeLabel('claude-code')} and {harnessTypeLabel('codex')} logins.
          </p>
        )}
        {instances.map((instance) => (
          <InstanceRow key={instance.id} instance={instance} onChanged={() => void load()} />
        ))}

        <div className="rounded-lg border border-dashed border-border p-4 space-y-3">
          <p className="text-xs font-medium">Add an account</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="harness-instance-harness">Harness</Label>
              <select
                id="harness-instance-harness"
                value={harness}
                onChange={(e) => setHarness(e.target.value as HarnessType)}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer"
              >
                {HARNESS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="harness-instance-label">Name</Label>
              <Input id="harness-instance-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Work" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="harness-instance-home">Home folder</Label>
              <Input
                id="harness-instance-home"
                value={homePath}
                onChange={(e) => setHomePath(e.target.value)}
                placeholder={harness === 'codex' ? '~/.codex-work' : '~/.claude-work'}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            {error ? <p className="text-xs text-destructive">{error}</p> : <span />}
            <Button size="sm" onClick={() => void add()} disabled={adding || !label.trim() || !homePath.trim()}>
              <Plus className="h-3.5 w-3.5" />
              Add account
            </Button>
          </div>
        </div>
      </div>
    </SettingsSection>
  )
}
