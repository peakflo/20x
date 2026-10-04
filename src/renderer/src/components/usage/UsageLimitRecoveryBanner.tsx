import { useEffect, useState } from 'react'
import { Clock } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { onUsageLimitRecoveryUpdated, usageApi } from '@/lib/ipc-client'
import { formatResetIn } from '@shared/usage'
import type { UsageLimitRecovery } from '@shared/usage-limit-recovery'

const CLOCK_TICK_MS = 30 * 1000

function formatClockTime(iso: string): string {
  const date = new Date(iso)
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

/**
 * Shown above a task's transcript after its agent stopped on a subscription
 * usage limit: when it will continue (or why it will not), with a toggle for
 * the scheduled continuation.
 */
export function UsageLimitRecoveryBanner({ taskId }: { taskId: string }) {
  const [recovery, setRecovery] = useState<UsageLimitRecovery | null>(null)
  const [pending, setPending] = useState(false)
  const [, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setRecovery(null)
    usageApi.getLimitRecovery(taskId)
      .then((value) => { if (!cancelled) setRecovery(value) })
      .catch(() => undefined)
    let off: () => void = () => undefined
    try {
      off = onUsageLimitRecoveryUpdated((value) => {
        if (value.taskId === taskId) setRecovery(value)
      })
    } catch {
      // Live updates unavailable (e.g. tests without the bridge).
    }
    return () => {
      cancelled = true
      off()
    }
  }, [taskId])

  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  if (!recovery || (recovery.status !== 'waiting' && recovery.status !== 'failed')) return null

  const toggle = async (autoResume: boolean): Promise<void> => {
    setPending(true)
    try {
      const next = await usageApi.setLimitRecoveryAutoResume(taskId, autoResume)
      if (next) setRecovery(next)
    } finally {
      setPending(false)
    }
  }

  let detail: string
  let action: { label: string; autoResume: boolean } | null = null
  if (recovery.status === 'failed') {
    detail = `Could not continue automatically${recovery.error ? `: ${recovery.error}` : ''}. Send a message to continue.`
  } else if (!recovery.resetAt) {
    detail = 'The provider did not report when the limit resets. Send a message to continue once it does.'
  } else if (recovery.autoResume) {
    const resetIn = formatResetIn(recovery.resetAt)
    detail = `Continues automatically at ${formatClockTime(recovery.resetAt)}${resetIn && resetIn !== 'now' ? ` (${resetIn})` : ''} when the limit resets.`
    action = { label: 'Cancel auto-continue', autoResume: false }
  } else {
    detail = `Limit resets at ${formatClockTime(recovery.resetAt)}. Send a message to continue, or continue automatically.`
    action = { label: 'Continue at reset', autoResume: true }
  }

  return (
    <div
      className="mx-3 mt-2 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5"
      role="status"
      data-testid="usage-limit-recovery-banner"
    >
      <Clock className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="text-sm font-medium text-foreground">Usage limit reached</div>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      {action && (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => void toggle(action!.autoResume)}>
          {action.label}
        </Button>
      )}
    </div>
  )
}
