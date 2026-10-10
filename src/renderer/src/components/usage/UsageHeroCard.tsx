import { useEffect, useRef } from 'react'
import { Share2 } from 'lucide-react'
import {
  buildUsageCardSummary,
  renderToCanvas,
  usageCardAriaLabel,
  type UsageCardSummary
} from '@shared/usage-card'
import type { UsageParallelismResponse } from '@shared/usage'
import { waitForFonts } from '@/lib/wait-for-fonts'

interface UsageHeroCardProps {
  data: UsageParallelismResponse | null
  loading: boolean
  /** Total tokens for the same period — from the existing token-usage summary fetch, not a second parallelism-specific one. */
  tokens: number
  periodLabel: string
  name: string
  onOpenShare: () => void
}

/**
 * The azure hero card on the Usage page — the one loud thing on the page.
 * Renders via the shared `drawCard` module at up to 2x device pixel ratio,
 * same as the mock's `renderHero`. Clicking it opens the Share dialog, same
 * as the Share button.
 */
export function UsageHeroCard({ data, loading, tokens, periodLabel, name, onOpenShare }: UsageHeroCardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const built = data ? buildUsageCardSummary(data, tokens, periodLabel) : null
  const summary: UsageCardSummary | null = built?.summary ?? null

  useEffect(() => {
    if (!summary || !canvasRef.current) return
    let cancelled = false
    void waitForFonts().then(() => {
      if (cancelled || !canvasRef.current) return
      const scale = Math.min(2, window.devicePixelRatio || 1)
      renderToCanvas(canvasRef.current, 'wide', summary, { theme: 'azure', name }, scale)
    })
    return () => {
      cancelled = true
    }
    // Re-draw whenever any summary field or the name changes.
  }, [summary, name])

  if (loading && !data) {
    return (
      <div className="relative rounded-[22px] overflow-hidden bg-card border border-border animate-pulse" style={{ aspectRatio: '1200 / 630' }} />
    )
  }

  if (!summary) {
    return (
      <div className="relative rounded-[22px] overflow-hidden bg-gradient-to-br from-[#1e96eb] to-[#1787d9] text-white flex flex-col items-center justify-center text-center gap-2 px-8" style={{ aspectRatio: '1200 / 630' }}>
        <p className="text-xl font-semibold">
          {built?.emptyReason === 'no-screen-time-data'
            ? 'Still learning your screen time'
            : 'Run a few agents at once and your multiplier shows up here'}
        </p>
        <p className="text-sm text-white/80 max-w-md">
          {built?.emptyReason === 'no-screen-time-data'
            ? "We can see agent work in this period, but not yet how much time you spent with 20x open — the multiplier needs both. It'll appear once there's enough of each."
            : data?.countingFromMs
              ? `Counting from ${new Date(data.countingFromMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.`
              : 'Your multiplier tracks how much agent work gets done per hour you spend in the app.'}
        </p>
      </div>
    )
  }

  return (
    <div className="relative rounded-[22px] overflow-hidden shadow-[0_24px_60px_-24px_rgba(30,150,235,.55)]">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={usageCardAriaLabel(summary)}
        onClick={onOpenShare}
        className="block w-full h-auto cursor-pointer"
      />
      <button
        type="button"
        onClick={onOpenShare}
        className="absolute right-[18px] bottom-4 inline-flex items-center gap-1.5 rounded-full border border-white/35 bg-white/15 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm hover:bg-white/25 transition-colors"
      >
        <Share2 className="h-3.5 w-3.5" />
        Share
      </button>
    </div>
  )
}
