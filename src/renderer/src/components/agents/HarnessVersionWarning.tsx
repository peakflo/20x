import { useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useHarnessMaintenanceStore } from '@/stores/harness-maintenance-store'
import { harnessDisplayLabel } from '@shared/harness-maintenance'
import { isHarnessKey } from '@shared/harness-versions'

/**
 * Small warning shown in the agent form when the selected harness's CLI is
 * below 20x's recommended version, or below the minimum it supports. Reads
 * the same harness-maintenance store as Settings → Agents, so it never
 * re-checks on its own — just renders whatever the last check found.
 */
export function HarnessVersionWarning({ codingAgent }: { codingAgent: string }) {
  const statuses = useHarnessMaintenanceStore((s) => s.statuses)
  const init = useHarnessMaintenanceStore((s) => s.init)

  useEffect(() => init(), [init])

  if (!isHarnessKey(codingAgent)) return null
  const status = statuses.find((s) => s.harness === codingAgent)
  if (!status || (status.status !== 'below_recommended' && status.status !== 'unsupported')) return null

  const message = status.status === 'unsupported'
    ? `${harnessDisplayLabel(codingAgent)} ${status.version ?? ''} is unsupported — tasks on this agent may fail. Update it in Settings → Agents.`
    : `${harnessDisplayLabel(codingAgent)} ${status.version ?? ''} is below 20x's recommended version. Update it in Settings → Agents.`

  return (
    <p
      className={`flex items-start gap-1.5 text-xs ${status.status === 'unsupported' ? 'text-destructive' : 'text-yellow-400'}`}
      data-testid="harness-version-warning"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
      {message}
    </p>
  )
}
