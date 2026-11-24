import { useState } from 'react'
import { AlertTriangle, ArrowUpCircle, Loader2, Lock, Monitor, MoreHorizontal, RefreshCw, ShieldAlert } from 'lucide-react'
import { Badge, type BadgeVariant } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn, formatRelativeDate } from '@/lib/utils'
import {
  machinesNeedingUpdate,
  type MachineRow,
  type MachineStatus,
  type MachinesFailure
} from '@shared/enterprise-runners'

export type MachinesViewState = 'idle' | 'loading' | 'ready' | 'error'

export interface MachinesTableProps {
  state: MachinesViewState
  error: MachinesFailure | null
  machines: MachineRow[]
  pinnedVersion: string | null
  busyIds: string[]
  onConnect: () => void
  onRetry: () => void
  onSignIn?: () => void
  onRename: (machine: MachineRow) => void
  onRemove: (machine: MachineRow) => void
  onUpdate: (machine: MachineRow) => void
  onReconnect: (machine: MachineRow) => void
  onUpdateAll: () => void
}

const STATUS_LABEL: Record<MachineStatus, string> = {
  online: 'Online',
  busy: 'Busy',
  offline: 'Offline',
  refused: 'Refused'
}
const STATUS_DOT: Record<MachineStatus, string> = {
  online: 'bg-emerald-500',
  busy: 'bg-amber-500',
  offline: 'bg-muted-foreground/40',
  refused: 'bg-red-500'
}

const HARNESS_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  pi: 'Pi',
  opencode: 'OpenCode'
}

export function harnessLabel(name: string): string {
  return HARNESS_LABEL[name] ?? name
}

function StatusCell({ machine }: { machine: MachineRow }) {
  const detail =
    machine.status === 'busy' && machine.activeSessions
      ? `Busy · ${machine.activeSessions} now`
      : STATUS_LABEL[machine.status]
  return (
    <span className="inline-flex items-center gap-1.5" data-testid={`status-${machine.id}`}>
      <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[machine.status])} aria-hidden />
      <span>{detail}</span>
    </span>
  )
}

function lastSeen(machine: MachineRow): string {
  if (machine.status === 'online' || machine.status === 'busy') return 'Online now'
  return machine.lastSeenAt ? formatRelativeDate(machine.lastSeenAt) : '—'
}

function VersionCell({ machine }: { machine: MachineRow }) {
  const { versionState } = machine
  const badge: { label: string; variant: BadgeVariant } | null =
    versionState.updating
      ? { label: 'Updating…', variant: 'blue' }
      : versionState.kind === 'up_to_date'
        ? { label: 'up to date', variant: 'green' }
        : versionState.kind === 'update_available'
          ? { label: `Update available${versionState.target ? ` · ${versionState.target}` : ''}`, variant: 'yellow' }
          : versionState.kind === 'refused'
            ? { label: 'Protocol too old · 426', variant: 'red' }
            : null
  return (
    <div className="space-y-0.5">
      <div className="font-mono text-xs">{machine.version ?? '—'}</div>
      {badge && <Badge variant={badge.variant}>{badge.label}</Badge>}
    </div>
  )
}

function HarnessCell({ machine }: { machine: MachineRow }) {
  if (machine.harnesses.length === 0) return <span className="text-muted-foreground">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {machine.harnesses.map((name) => (
        <Badge key={name}>{harnessLabel(name)}</Badge>
      ))}
    </div>
  )
}

function PinnedCell({ machine }: { machine: MachineRow }) {
  if (machine.pinnedAgents.length === 0) return <span className="text-muted-foreground">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {machine.pinnedAgents.map((agent) => (
        <Badge key={agent.id} variant="blue">
          {agent.name}
        </Badge>
      ))}
    </div>
  )
}

function RowActions({
  machine,
  busy,
  onRename,
  onRemove,
  onUpdate,
  onReconnect
}: {
  machine: MachineRow
  busy: boolean
  onRename: () => void
  onRemove: () => void
  onUpdate: () => void
  onReconnect: () => void
}) {
  const [open, setOpen] = useState(false)
  if (!machine.canManage) {
    return (
      <span className="text-xs text-muted-foreground" title="Who can use a machine is controlled in Spaces.">
        {machine.scope === 'shared' ? 'read-only' : '—'}
      </span>
    )
  }
  const canUpdate =
    (machine.versionState.kind === 'update_available' || machine.versionState.kind === 'refused') &&
    !machine.versionState.updating &&
    machine.update?.supported !== false
  const canReconnect = machine.scope === 'mine' && (machine.status === 'offline' || machine.status === 'refused')
  return (
    <div className="relative flex items-center justify-end gap-1">
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-label="Working" />}
      {canUpdate && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={onUpdate} aria-label={`Update ${machine.name}`}>
          Update
        </Button>
      )}
      <Button
        size="icon"
        variant="ghost"
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
        aria-label={`More actions for ${machine.name}`}
        aria-expanded={open}
      >
        <MoreHorizontal className="h-4 w-4" />
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-20 min-w-[9rem] rounded-lg border border-border bg-popover p-1 text-sm shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          <button role="menuitem" className="block w-full rounded-md px-2.5 py-1.5 text-left hover:bg-accent" onClick={() => { setOpen(false); onRename() }}>
            Rename
          </button>
          {canReconnect && (
            <button role="menuitem" className="block w-full rounded-md px-2.5 py-1.5 text-left hover:bg-accent" onClick={() => { setOpen(false); onReconnect() }}>
              Reconnect
            </button>
          )}
          <button role="menuitem" className="block w-full rounded-md px-2.5 py-1.5 text-left text-destructive hover:bg-accent" onClick={() => { setOpen(false); onRemove() }}>
            Remove machine
          </button>
        </div>
      )}
    </div>
  )
}

function Section({ title, subtitle, children, colSpan }: { title: string; subtitle?: string; children: React.ReactNode; colSpan: number }) {
  return (
    <>
      <tr>
        <td colSpan={colSpan} className="bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground">
          {title}
          {subtitle && <span className="ml-2 font-normal text-muted-foreground/70">{subtitle}</span>}
        </td>
      </tr>
      {children}
    </>
  )
}

const COLUMNS = ['Name', 'Status', 'Last seen', 'Version', 'Harnesses', 'Pinned agents', ''] as const

export function MachinesTable(props: MachinesTableProps) {
  const { state, error, machines, busyIds } = props

  if (state === 'loading' || state === 'idle') {
    return (
      <div className="space-y-2 rounded-xl border border-border/60 p-4" role="status" aria-label="Loading machines">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-9 animate-pulse rounded-md bg-muted/50" />
        ))}
        <p className="text-xs text-muted-foreground">Loading machines from Spaces…</p>
      </div>
    )
  }

  if (state === 'error' && error?.kind === 'not_signed_in') {
    return (
      <EmptyState
        icon={Lock}
        title="Sign in to Peakflo Enterprise"
        description="Machines are managed in your Spaces workspace."
        action={props.onSignIn ? <Button onClick={props.onSignIn}>Sign in</Button> : undefined}
      />
    )
  }

  if (state === 'error' && error?.kind === 'permission_denied') {
    return (
      <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
        <div className="space-y-1">
          <div className="font-medium">Permission denied</div>
          <p className="text-muted-foreground">
            Only the machine&apos;s owner or a workspace admin can see and manage machines. Ask an admin in Spaces for access.
          </p>
          {error.message && <p className="text-xs text-muted-foreground/70">{error.message}</p>}
        </div>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div role="alert" className="flex items-start gap-3 rounded-xl border border-border/60 p-4 text-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        <div className="space-y-2">
          <div className="font-medium">Couldn&apos;t load machines</div>
          <p className="text-muted-foreground">{error?.message ?? 'Spaces is unavailable.'}</p>
          <Button size="sm" variant="secondary" onClick={props.onRetry}>
            <RefreshCw className="h-3.5 w-3.5" /> Try again
          </Button>
        </div>
      </div>
    )
  }

  if (machines.length === 0) {
    return (
      <EmptyState
        icon={Monitor}
        title="No machines yet"
        description="Connect this computer to run Claude Code, Codex or Cursor from Spaces and your phone. macOS and Linux only — Windows isn’t supported."
        action={<Button onClick={props.onConnect}>Connect this computer</Button>}
      />
    )
  }

  const mine = machines.filter((m) => m.scope === 'mine')
  const shared = machines.filter((m) => m.scope === 'shared')
  const refused = machines.filter((m) => m.versionState.kind === 'refused')
  const updatable = machinesNeedingUpdate(machines).filter((m) => m.versionState.kind === 'update_available')
  const updateAvailable = machines.filter((m) => m.versionState.kind === 'update_available')

  const renderRow = (machine: MachineRow) => (
    <tr key={machine.id} className="border-t border-border/50 align-top" data-testid={`machine-${machine.id}`}>
      <td className="px-3 py-2.5">
        <div className="font-medium">{machine.name}</div>
        <div className="text-xs text-muted-foreground">
          {[machine.platform, machine.thisComputer ? 'this computer' : null, machine.scope === 'shared' && machine.ownerName ? machine.ownerName : null]
            .filter(Boolean)
            .join(' · ') || ' '}
        </div>
      </td>
      <td className="px-3 py-2.5 text-sm"><StatusCell machine={machine} /></td>
      <td className="px-3 py-2.5 text-sm text-muted-foreground">{lastSeen(machine)}</td>
      <td className="px-3 py-2.5"><VersionCell machine={machine} /></td>
      <td className="px-3 py-2.5"><HarnessCell machine={machine} /></td>
      <td className="px-3 py-2.5"><PinnedCell machine={machine} /></td>
      <td className="px-3 py-2.5">
        <RowActions
          machine={machine}
          busy={busyIds.includes(machine.id)}
          onRename={() => props.onRename(machine)}
          onRemove={() => props.onRemove(machine)}
          onUpdate={() => props.onUpdate(machine)}
          onReconnect={() => props.onReconnect(machine)}
        />
      </td>
    </tr>
  )

  return (
    <div className="space-y-3">
      {refused.length > 0 && (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-sm" data-testid="refused-banner">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
          <div className="space-y-1">
            <div>
              <span className="font-medium">{refused.map((m) => m.name).join(', ')}</span>{' '}
              {refused.length === 1 ? 'is' : 'are'} refused (426).
            </div>
            <p className="text-muted-foreground">
              Its protocol is older than the server&apos;s minimum, so it takes no new work. It recovers on its own: the
              service updates itself and rejoins, and running sessions resume. Update is the manual fallback.
            </p>
          </div>
        </div>
      )}
      {updateAvailable.length > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm" data-testid="update-banner">
          <div className="flex items-start gap-3">
            <ArrowUpCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <p>
              <span className="font-medium">{updateAvailable.length} update{updateAvailable.length === 1 ? '' : 's'} available.</span>{' '}
              <span className="text-muted-foreground">
                {props.pinnedVersion ? `The server recommends ${props.pinnedVersion}. ` : ''}
                Machines keep working — update when convenient. Updating works while a machine is busy.
              </span>
            </p>
          </div>
          {updatable.length > 0 && (
            <Button size="sm" variant="secondary" onClick={props.onUpdateAll}>
              Update all
            </Button>
          )}
        </div>
      )}

      <div className="overflow-visible rounded-xl border border-border/60">
        <table className="w-full table-fixed text-left">
          <colgroup>
            <col className="w-[20%]" />
            <col className="w-[12%]" />
            <col className="w-[11%]" />
            <col className="w-[16%]" />
            <col className="w-[16%]" />
            <col className="w-[13%]" />
            <col className="w-[12%]" />
          </colgroup>
          <thead>
            <tr className="text-xs text-muted-foreground">
              {COLUMNS.map((column, i) => (
                <th key={i} scope="col" className="px-3 py-2 font-medium">
                  {column || <span className="sr-only">Actions</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mine.length > 0 && <Section title="My machines" colSpan={7}>{mine.map(renderRow)}</Section>}
            {shared.length > 0 && (
              <Section title="Shared runners" subtitle="managed by your admin" colSpan={7}>
                {shared.map(renderRow)}
              </Section>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Who can use a machine is controlled in Spaces (sharing and permissions). 20x only shows what you&apos;re allowed to
        use. Runners also self-update when they meet a newer server.
      </p>
    </div>
  )
}
