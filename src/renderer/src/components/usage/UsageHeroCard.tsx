import { useEffect, useRef } from 'react'
import {
  buildUsageCardSummary,
  renderToCanvas,
  usageCardAriaLabel,
  type UsageCardSummary
} from '@shared/usage-card'
import type { UsageDayRow, UsageParallelismResponse } from '@shared/usage'
import { waitForFonts } from '@shared/wait-for-fonts'

interface UsageHeroCardProps {
  data: UsageParallelismResponse | null
  /** Same per-day token summary the tokens-per-day chart reads — feeds the calendar's per-day value, so the two always agree on which days were busy. */
  byDay: UsageDayRow[]
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
export function UsageHeroCard({ data, byDay, loading, tokens, periodLabel, name, onOpenShare }: UsageHeroCardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const built = data ? buildUsageCardSummary(data, byDay, tokens, periodLabel) : null
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

  // `summary` is only null when there's no agent-run data at all (live or
  // backfilled) — once there's any, the card always draws (calendar, peak
  // day, tasks, tokens all real); a not-yet-ready multiplier shows its own
  // in-card placeholder instead of hiding the whole card. See
  // buildUsageCardSummary / the module docstring in usage-card.ts.
  if (!summary) {
    const detail = data?.countingFromMs
      ? `Counting from ${new Date(data.countingFromMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.`
      : 'Your multiplier tracks how much agent work gets done per hour you spend in the app.'
    return (
      <div className="relative rounded-[22px] overflow-hidden bg-gradient-to-br from-[#1e96eb] to-[#1787d9] text-white flex flex-col items-center justify-center text-center gap-2 px-8" style={{ aspectRatio: '1200 / 630' }}>
        <p className="text-xl font-semibold">Run a few agents at once and your multiplier shows up here</p>
        <p className="text-sm text-white/80 max-w-md">{detail}</p>
      </div>
    )
  }

  return (
    <div className="relative rounded-[22px] overflow-hidden shadow-[0_24px_60px_-24px_rgba(30,150,235,.55)]">
      {/* The whole card opens Share on click — the page already has one Share button (top-right); a second one floating on the card itself was a duplicate. */}
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={usageCardAriaLabel(summary)}
        onClick={onOpenShare}
        className="block w-full h-auto cursor-pointer"
      />
    </div>
  )
}
