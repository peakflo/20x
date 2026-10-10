import { useEffect, useState } from 'react'
import { Plug, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { SettingsSection } from '../SettingsSection'
import { acpInstanceApi } from '@/lib/ipc-client'
import { useAcpInstanceStore } from '@/stores/acp-instance-store'
import { AddAcpAgentDialog } from '@/components/agents/AddAcpAgentDialog'
import type { AcpAgentInstanceView } from '@shared/acp-registry'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function InstanceCard({ instance, onChanged }: { instance: AcpAgentInstanceView; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)

  const remove = async (): Promise<void> => {
    setError(null)
    setRemoving(true)
    try {
      await acpInstanceApi.delete(instance.id)
      onChanged()
    } catch (err) {
      setError(errorMessage(err))
      setRemoving(false)
    }
  }

  const commandSummary =
    instance.source === 'local'
      ? [instance.command_path, ...instance.command_args].filter(Boolean).join(' ')
      : instance.command_path
        ? `${instance.command_path} (override)`
        : `registry: ${instance.registry_agent_id ?? '?'}${instance.version ? ` @ ${instance.version}` : ''}`

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 space-y-2" data-testid={`acp-instance-${instance.id}`}>
      <div className="flex items-center gap-2 min-w-0">
        <Plug className="h-4 w-4 text-sky-300/80 shrink-0" />
        <span className="font-medium text-sm truncate">{instance.display_name}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium shrink-0">
          {instance.source === 'registry' ? 'Registry' : 'Local command'}
        </span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <Button size="sm" variant="ghost" onClick={() => void remove()} disabled={removing} aria-label={`Remove ${instance.display_name}`}>
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground font-mono break-all">{commandSummary}</p>
      {instance.command_args.length > 0 && instance.source === 'registry' && (
        <p className="text-[11px] text-muted-foreground">Extra args: {instance.command_args.join(' ')}</p>
      )}
      {Object.keys(instance.env).length > 0 && (
        <p className="text-[11px] text-muted-foreground">Env: {Object.keys(instance.env).join(', ')}</p>
      )}
      {instance.custom_models.length > 0 && (
        <p className="text-[11px] text-muted-foreground">Custom models: {instance.custom_models.join(', ')}</p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

/**
 * Settings → Harnesses: configured ACP (Agent Client Protocol) agents, each a
 * registry install or a local command. Each instance is its own harness
 * dropdown entry in the agent form (see `acpInstanceDropdownOptions`).
 */
export function AcpAgentsSection() {
  const instances = useAcpInstanceStore((s) => s.instances)
  const load = useAcpInstanceStore((s) => s.load)
  const [dialogOpen, setDialogOpen] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  return (
    <SettingsSection
      title="ACP agents"
      description="Agents added from the official ACP registry, or pointed at a local ACP command. Registry agents are third-party code — review before adding."
    >
      <div className="space-y-3">
        {instances.length === 0 && <p className="text-xs text-muted-foreground">No ACP agents configured yet.</p>}
        {instances.map((instance) => (
          <InstanceCard key={instance.id} instance={instance} onChanged={() => void load()} />
        ))}
        <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          Add ACP agent
        </Button>
      </div>
      <AddAcpAgentDialog open={dialogOpen} onOpenChange={setDialogOpen} onAdded={() => void load()} />
    </SettingsSection>
  )
}
