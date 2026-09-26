import { useEffect, useState } from 'react'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { fetchAiUsage, usageLevel, type AiUsage } from '@/lib/ai-usage'

const REFRESH_MS = 5 * 60 * 1000
const COLORS = { normal: 'text-primary', warn: 'text-amber-500', critical: 'text-red-500' } as const

/** Small progress ring showing Peakflo AI subscription usage. Renders nothing without a subscription. */
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

  const r = 5
  const c = 2 * Math.PI * r
  const level = usageLevel(usage.percent)
  const parts = [`Peakflo AI: ${usage.percent}% used`]
  if (usage.used !== null && usage.limit !== null) parts.push(`${usage.used.toFixed(2)} / ${usage.limit.toFixed(2)}`)
  if (usage.resetAt) parts.push(`resets ${new Date(usage.resetAt).toLocaleDateString()}`)

  return (
    <span className={`flex items-center gap-1.5 ${COLORS[level]}`} title={parts.join(' · ')} data-testid="ai-usage-ring">
      <svg width="12" height="12" viewBox="0 0 12 12" className="-rotate-90">
        <circle cx="6" cy="6" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.5" />
        <circle cx="6" cy="6" r={r} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - usage.percent / 100)} />
      </svg>
      {usage.percent}%
    </span>
  )
}
