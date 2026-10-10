import { useCallback, useEffect, useRef, useState } from 'react'
import { Share2 } from 'lucide-react'
import { api } from '../api/client'
import { onEvent } from '../api/websocket'
import {
  buildUsageCardSummary,
  renderToCanvas,
  usageCardAriaLabel,
  usagePeriodLabel,
  type UsageCardSummary
} from '@shared/usage-card'
import { USAGE_RECORDED_CHANNEL, totalTokens, type UsageParallelismResponse } from '@shared/usage'
import { waitForFonts } from '@shared/wait-for-fonts'

/** Fixed period for the mobile hero — matches the approved mock's own default. No period switcher on mobile; this view is read-only. */
const PERIOD_DAYS = 30

/** Read-only "my multiplier" hero card for the mobile Settings page, fed by GET /api/usage/parallelism. */
export function UsageHeroSection() {
  const [data, setData] = useState<UsageParallelismResponse | null>(null)
  const [tokens, setTokens] = useState(0)
  const [loading, setLoading] = useState(true)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const load = useCallback(() => {
    const utcOffsetMinutes = -new Date().getTimezoneOffset()
    Promise.all([
      api.usage.parallelism(PERIOD_DAYS, utcOffsetMinutes),
      api.usage.summary({ sinceMs: Date.now() - PERIOD_DAYS * 86_400_000, untilMs: Date.now() + 1, utcOffsetMinutes })
    ])
      .then(([parallelism, summary]) => {
        setData(parallelism)
        setTokens(summary ? totalTokens(summary.totals) : 0)
      })
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
    const off = onEvent(USAGE_RECORDED_CHANNEL, load)
    return off
  }, [load])

  const periodLabel = usagePeriodLabel(PERIOD_DAYS)
  const built = data ? buildUsageCardSummary(data, tokens, periodLabel) : null
  const summary: UsageCardSummary | null = built?.summary ?? null

  useEffect(() => {
    if (!summary || !canvasRef.current) return
    let cancelled = false
    void waitForFonts().then(() => {
      if (cancelled || !canvasRef.current) return
      const scale = Math.min(2, window.devicePixelRatio || 1)
      renderToCanvas(canvasRef.current, 'wide', summary, { theme: 'azure', name: '' }, scale)
    })
    return () => {
      cancelled = true
    }
  }, [summary])

  const handleShare = async (): Promise<void> => {
    if (!summary) return
    const canvas = document.createElement('canvas')
    renderToCanvas(canvas, 'wide', summary, { theme: 'azure', name: '' }, 1)
    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) return
    const file = new File([blob], `20x-usage-${PERIOD_DAYS}d-wide.png`, { type: 'image/png' })

    const nav = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean; share?: (data: { files: File[]; title?: string }) => Promise<void> }
    if (nav.canShare?.({ files: [file] }) && nav.share) {
      try {
        await nav.share({ files: [file], title: '20x usage' })
        return
      } catch {
        // User canceled the share sheet, or sharing failed — fall through to the long-press fallback.
      }
    }
    // No Web Share API (or it can't share files here) — open the image in a new tab so the user can long-press to save it.
    const url = URL.createObjectURL(blob)
    window.open(url, '_blank')
  }

  if (loading && !data) {
    return <div className="rounded-2xl bg-muted animate-pulse" style={{ aspectRatio: '1200 / 630' }} />
  }

  // `summary` is only null when there's no agent-run data at all (live or
  // backfilled) — once there's any, the card always draws (calendar, peak
  // day, tasks, tokens all real); a not-yet-ready multiplier shows its own
  // in-card placeholder instead of hiding the whole card. See
  // buildUsageCardSummary / the module docstring in usage-card.ts.
  if (!summary) {
    return (
      <div className="rounded-2xl bg-gradient-to-br from-[#1e96eb] to-[#1787d9] text-white flex flex-col items-center justify-center text-center gap-1.5 px-6 py-10">
        <p className="text-base font-semibold">Run a few agents at once and your multiplier shows up here</p>
        <p className="text-xs text-white/80">
          Your multiplier tracks how much agent work gets done per hour you spend in the app.
        </p>
      </div>
    )
  }

  return (
    <div className="relative rounded-2xl overflow-hidden shadow-lg">
      <canvas ref={canvasRef} role="img" aria-label={usageCardAriaLabel(summary)} className="block w-full h-auto" />
      <button
        type="button"
        onClick={() => void handleShare()}
        className="absolute right-3 bottom-3 inline-flex items-center gap-1.5 rounded-full border border-white/35 bg-white/15 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm"
      >
        <Share2 className="h-3.5 w-3.5" />
        Share
      </button>
    </div>
  )
}
