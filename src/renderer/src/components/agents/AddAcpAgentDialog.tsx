import { useEffect, useState } from 'react'
import { ExternalLink, Loader2, Plus, Search, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/Dialog'
import { acpInstanceApi, acpRegistryApi } from '@/lib/ipc-client'
import type { AcpRegistrySearchResult, LocalCommandValidationResult } from '@shared/acp-registry'
import { cn } from '@/lib/utils'

type AcpAddTab = 'registry' | 'local'

const SEARCH_DEBOUNCE_MS = 300

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** One registry search result row, with an inline "name it and add" step. */
function RegistryResultRow({ result, onAdded }: { result: AcpRegistrySearchResult; onAdded: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [displayName, setDisplayName] = useState(result.name)
  const [busy, setBusy] = useState<'idle' | 'installing' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)

  const add = async (): Promise<void> => {
    setError(null)
    setBusy('installing')
    try {
      const instance = await acpInstanceApi.create({
        display_name: displayName.trim() || result.name,
        source: 'registry',
        registry_agent_id: result.id,
        version: result.version,
        distribution: 'auto'
      })
      const installResult = await acpInstanceApi.install(instance.id)
      if (!installResult.ok) {
        setError(installResult.error)
        setBusy('idle')
        return
      }
      setBusy('done')
      onAdded()
    } catch (err) {
      setError(errorMessage(err))
      setBusy('idle')
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 space-y-2" data-testid={`acp-registry-result-${result.id}`}>
      <div className="flex items-start gap-3">
        {result.icon && <img src={result.icon} alt="" className="h-6 w-6 rounded shrink-0 mt-0.5" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{result.name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono">v{result.version}</span>
            {result.license && <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{result.license}</span>}
            {!result.installableHere && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-300">Not installable here</span>
            )}
          </div>
          {result.description && <p className="text-xs text-muted-foreground mt-0.5">{result.description}</p>}
          {result.repository && (
            <a
              href={result.repository}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground mt-1"
            >
              Repository <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <Button
          size="sm"
          variant={expanded ? 'ghost' : 'outline'}
          onClick={() => setExpanded((e) => !e)}
          disabled={!result.installableHere}
        >
          {expanded ? 'Cancel' : 'Add'}
        </Button>
      </div>

      {expanded && (
        <div className="space-y-2 pt-2 border-t border-border">
          <p className="text-[11px] text-muted-foreground">
            This runs third-party code, not written or reviewed by 20x. Review it before adding, especially its repository and license.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor={`acp-name-${result.id}`}>Display name</Label>
            <Input id={`acp-name-${result.id}`} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button size="sm" onClick={() => void add()} disabled={busy !== 'idle' || !displayName.trim()}>
            {busy === 'installing' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {busy === 'installing' ? 'Installing…' : 'Install & add'}
          </Button>
        </div>
      )}
    </div>
  )
}

function RegistryTab({ onAdded }: { onAdded: () => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AcpRegistrySearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const timer = setTimeout(() => {
      void acpRegistryApi
        .search(query)
        .then((found) => {
          if (!cancelled) setResults(found)
        })
        .catch((err) => {
          if (!cancelled) setError(errorMessage(err))
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the ACP agent registry…"
          className="pl-9"
          aria-label="Search the ACP agent registry"
        />
        {loading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {results.map((result) => (
          <RegistryResultRow key={result.id} result={result} onAdded={onAdded} />
        ))}
        {!loading && results.length === 0 && <p className="text-xs text-muted-foreground py-4 text-center">No agents found.</p>}
      </div>
    </div>
  )
}

interface ArgRow {
  id: string
  value: string
}
interface EnvRow {
  id: string
  key: string
  value: string
}

let rowCounter = 0
function nextRowId(): string {
  rowCounter += 1
  return `row-${rowCounter}`
}

function LocalCommandTab({ onAdded }: { onAdded: () => void }) {
  const [displayName, setDisplayName] = useState('')
  const [executable, setExecutable] = useState('')
  const [args, setArgs] = useState<ArgRow[]>([])
  const [env, setEnv] = useState<EnvRow[]>([])
  const [validation, setValidation] = useState<LocalCommandValidationResult | null>(null)
  const [validating, setValidating] = useState(false)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const validate = async (): Promise<void> => {
    if (!executable.trim()) return
    setValidating(true)
    try {
      setValidation(await acpInstanceApi.validateLocalCommand(executable.trim()))
    } catch (err) {
      setValidation({ ok: false, kind: 'not-found', message: errorMessage(err) })
    } finally {
      setValidating(false)
    }
  }

  const add = async (): Promise<void> => {
    setError(null)
    setAdding(true)
    try {
      await acpInstanceApi.create({
        display_name: displayName.trim() || executable.trim(),
        source: 'local',
        command_path: executable.trim(),
        command_args: args.map((a) => a.value).filter((v) => v.length > 0),
        env: Object.fromEntries(env.filter((e) => e.key.trim()).map((e) => [e.key.trim(), e.value]))
      })
      onAdded()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="acp-local-name">Display name</Label>
        <Input id="acp-local-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="My ACP agent" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="acp-local-executable">Executable</Label>
        <div className="flex gap-2">
          <Input
            id="acp-local-executable"
            value={executable}
            onChange={(e) => {
              setExecutable(e.target.value)
              setValidation(null)
            }}
            placeholder="/usr/local/bin/my-acp-agent"
            className="font-mono"
          />
          <Button size="sm" variant="outline" onClick={() => void validate()} disabled={!executable.trim() || validating}>
            {validating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Validate'}
          </Button>
        </div>
        {validation && (
          <p className={cn('text-[11px]', validation.ok ? 'text-emerald-400' : 'text-destructive')}>
            {validation.ok ? 'Looks good.' : validation.message}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label>Arguments</Label>
        {args.map((arg, i) => (
          <div key={arg.id} className="flex gap-2">
            <Input
              aria-label={`Argument ${i + 1}`}
              value={arg.value}
              onChange={(e) => setArgs((rows) => rows.map((r) => (r.id === arg.id ? { ...r, value: e.target.value } : r)))}
              placeholder="--flag"
            />
            <Button size="sm" variant="ghost" onClick={() => setArgs((rows) => rows.filter((r) => r.id !== arg.id))} aria-label="Remove argument">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setArgs((rows) => [...rows, { id: nextRowId(), value: '' }])}>
          <Plus className="h-3.5 w-3.5" /> Add argument
        </Button>
      </div>

      <div className="space-y-1.5">
        <Label>Environment variables</Label>
        {env.map((row, i) => (
          <div key={row.id} className="flex gap-2">
            <Input
              aria-label={`Env var name ${i + 1}`}
              value={row.key}
              onChange={(e) => setEnv((rows) => rows.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r)))}
              placeholder="MY_VAR"
              className="font-mono"
            />
            <Input
              aria-label={`Env var value ${i + 1}`}
              value={row.value}
              onChange={(e) => setEnv((rows) => rows.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)))}
              placeholder="value"
            />
            <Button size="sm" variant="ghost" onClick={() => setEnv((rows) => rows.filter((r) => r.id !== row.id))} aria-label="Remove env var">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setEnv((rows) => [...rows, { id: nextRowId(), key: '', value: '' }])}>
          <Plus className="h-3.5 w-3.5" /> Add env var
        </Button>
        <p className="text-[11px] text-muted-foreground">
          Secret values (API keys, tokens) belong in Settings → Secrets, referenced by the agent form — not typed here in plain text.
        </p>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button onClick={() => void add()} disabled={adding || !executable.trim()}>
        {adding && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Add local ACP agent
      </Button>
    </div>
  )
}

export function AddAcpAgentDialog({
  open,
  onOpenChange,
  onAdded
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: () => void
}) {
  const [tab, setTab] = useState<AcpAddTab>('registry')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add ACP agent</DialogTitle>
          <DialogDescription>
            Add an agent from the official ACP registry, or point at a local ACP command.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex gap-1 mb-4 border-b border-border" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'registry'}
              onClick={() => setTab('registry')}
              className={cn(
                'px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer',
                tab === 'registry' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              Registry search
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'local'}
              onClick={() => setTab('local')}
              className={cn(
                'px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer',
                tab === 'local' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              Local ACP command
            </button>
          </div>
          {tab === 'registry' ? (
            <RegistryTab onAdded={() => { onAdded(); onOpenChange(false) }} />
          ) : (
            <LocalCommandTab onAdded={() => { onAdded(); onOpenChange(false) }} />
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
