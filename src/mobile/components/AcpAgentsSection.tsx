import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { AcpAgentInstanceView } from '@shared/acp-registry'

/**
 * Read-only list of configured ACP (Agent Client Protocol) agents, for the
 * mobile Settings page. Adding, editing, and signing in to an ACP agent is
 * desktop only (Settings → Harnesses) — this view just shows what is already
 * configured, so a task's harness choice makes sense on mobile too.
 */
export function AcpAgentsSection() {
  const [instances, setInstances] = useState<AcpAgentInstanceView[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    api.acpInstances
      .list()
      .then(setInstances)
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [])

  if (!loaded || instances.length === 0) return null

  return (
    <div>
      <h2 className="text-sm font-semibold text-foreground mb-3">ACP agents</h2>
      <div className="space-y-2">
        {instances.map((instance) => (
          <div
            key={instance.id}
            className="rounded-lg border border-border/50 bg-card p-3 flex items-center justify-between gap-2"
            data-testid={`mobile-acp-instance-${instance.id}`}
          >
            <span className="text-sm font-medium truncate">{instance.display_name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
              {instance.source === 'registry' ? 'Registry' : 'Local command'}
            </span>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground mt-2">
        Add or sign in to an ACP agent from the desktop app (Settings → Harnesses).
      </p>
    </div>
  )
}
