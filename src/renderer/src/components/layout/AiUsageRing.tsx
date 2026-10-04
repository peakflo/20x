import { useEffect, useState } from 'react'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { fetchAiUsage, usageLevel, type AiUsage } from '@/lib/ai-usage'
import { Sparkles } from 'lucide-react'
import { UsageChip } from '@/components/usage/UsageChip'

const REFRESH_MS = 5 * 60 * 1000
const CHIP_LEVEL = { normal: 'normal', warn: 'warning', critical: 'critical' } as const
const BAR = { normal: 'bg-primary', warn: 'bg-warning', critical: 'bg-destructive' } as const

/** Status-bar meter for Peakflo AI subscription usage (hover for details). Renders nothing without a subscription. */
export function AiUsageRing({ usage: override }: { usage?: AiUsage | null }) {
  const [fetched, setFetched] = useState<AiUsage | null>(null)
  const running = useAgentStore((s) => {
    let n = 0
    for (const session of s.sessions.values()) if (session.status !== SessionStatus.IDLE) n++
    return n
  })

  useEffect(() => {
    if (override !== undefined) return
    const request = window.electronAPI?.enterprise?.apiRequest
    if (!request) return
    let cancelled = false
    const load = (): void => {
      fetchAiUsage(request).then((u) => !cancelled && setFetched(u)).catch(() => !cancelled && setFetched(null))
    }
    load()
    const id = setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [override])

  // Refresh when an agent session finishes (running count drops).
  const [prevRunning, setPrevRunning] = useState(running)
  useEffect(() => {
    if (override !== undefined) return
    if (running < prevRunning) {
      const request = window.electronAPI?.enterprise?.apiRequest
      if (request) fetchAiUsage(request).then(setFetched).catch(() => setFetched(null))
    }
    setPrevRunning(running)
  }, [running])

  const usage = override !== undefined ? override : fetched
  if (!usage) return null

  const level = usageLevel(usage.percent)
  let resetText: string | null = null
  if (usage.resetAt) {
    const reset = new Date(usage.resetAt)
    if (!Number.isNaN(reset.getTime())) {
      const days = Math.ceil((reset.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
      const when = days <= 0 ? 'today' : days === 1 ? 'in 1 day' : `in ${days} days`
      resetText = `Resets ${when} (${reset.toLocaleDateString()})`
    }
  }
  const label = [`Peakflo AI: ${usage.percent}% used`, resetText].filter(Boolean).join(' · ')

  return (
    <UsageChip
      icon={<Sparkles className="h-2.5 w-2.5" />}
      label={label}
      percent={usage.percent}
      level={CHIP_LEVEL[level]}
      testId="ai-usage-ring"
      detailsTestId="ai-usage-tooltip"
      details={
        <div className="w-64 rounded-lg border border-border bg-card p-4 space-y-3 shadow-lg">
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            <span className="text-sm font-semibold text-foreground">Peakflo AI</span>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="font-medium text-foreground">Subscription</span>
              <span className="text-muted-foreground tabular-nums">{usage.percent}% used</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div className={`h-full rounded-full ${BAR[level]}`} style={{ width: `${usage.percent}%` }} />
            </div>
          </div>
          {resetText && <p className="text-[11px] text-muted-foreground">{resetText}</p>}
        </div>
      }
    />
  )
}
