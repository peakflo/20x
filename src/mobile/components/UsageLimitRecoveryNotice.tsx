import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { onEvent } from '../api/websocket'
import { formatResetIn } from '@shared/usage'
import { USAGE_LIMIT_RECOVERY_UPDATED_CHANNEL, type UsageLimitRecovery } from '@shared/usage-limit-recovery'

/** Mobile counterpart of the desktop usage-limit recovery banner. */
export function UsageLimitRecoveryNotice({ taskId }: { taskId: string }) {
  const [recovery, setRecovery] = useState<UsageLimitRecovery | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    let cancelled = false
    setRecovery(null)
    api.usage.limitRecovery(taskId).then((value) => { if (!cancelled) setRecovery(value) }).catch(() => undefined)
    const off = onEvent(USAGE_LIMIT_RECOVERY_UPDATED_CHANNEL, (payload) => {
      const value = payload as UsageLimitRecovery
      if (value?.taskId === taskId) setRecovery(value)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [taskId])

  if (!recovery || (recovery.status !== 'waiting' && recovery.status !== 'failed')) return null

  const toggle = async (autoResume: boolean): Promise<void> => {
    setPending(true)
    try {
      const next = await api.usage.setLimitRecoveryAutoResume(taskId, autoResume)
      if (next) setRecovery(next)
    } catch {
      // Keep the current state; the user can retry.
    } finally {
      setPending(false)
    }
  }

  const resetAt = recovery.resetAt
  const when = resetAt ? new Date(resetAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null
  const resetIn = resetAt ? formatResetIn(resetAt) : null
  let detail: string
  if (recovery.status === 'failed') detail = 'Could not continue automatically. Send a message to continue.'
  else if (!resetAt) detail = 'Reset time unknown. Send a message to continue once the limit resets.'
  else if (recovery.autoResume) detail = `Continues automatically at ${when}${resetIn && resetIn !== 'now' ? ` (${resetIn})` : ''}.`
  else detail = `Limit resets at ${when}. Send a message to continue.`

  return (
    <div className="shrink-0 mx-3 mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">Usage limit reached</div>
          <p className="text-xs text-muted-foreground">{detail}</p>
        </div>
        {recovery.status === 'waiting' && resetAt && (
          <button
            onClick={() => void toggle(!recovery.autoResume)}
            disabled={pending}
            className="shrink-0 text-xs text-primary disabled:opacity-50"
          >
            {recovery.autoResume ? 'Cancel' : 'Continue at reset'}
          </button>
        )}
      </div>
    </div>
  )
}
