import { useMemo, useState } from 'react'
import {
  buildUsageChartSeries,
  formatTokenCount,
  formatUsd,
  type UsageChartSeries,
  type UsageDayRow,
  type UsageProvider
} from '@shared/usage'

interface TokensPerDayChartProps {
  days: UsageDayRow[]
  /** 'dark' | 'light' — picks the chart-series palette; the app's own light/dark mode, not the (independent) Share dialog theme. */
  colorScheme: 'dark' | 'light'
}

const WIDTH = 640
const HEIGHT = 230
const LEFT = 38
const RIGHT = 6
const TOP = 8
const BOTTOM = 22

function fmtDate(day: string): string {
  const d = new Date(`${day}T00:00:00`)
  if (Number.isNaN(d.getTime())) return day
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Stacked-by-harness tokens-per-day chart, with legend, hover tooltip, and a "View as table" toggle — matches the approved mock's `renderChart`. */
export function TokensPerDayChart({ days, colorScheme }: TokensPerDayChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)

  const presentProviders = useMemo(() => {
    const set = new Set<UsageProvider>()
    for (const day of days) for (const p of day.byProvider) if (p.tokens > 0) set.add(p.provider)
    return [...set]
  }, [days])

  const series = useMemo(() => buildUsageChartSeries(presentProviders, colorScheme), [presentProviders, colorScheme])

  /** Tokens for one series on one day, folding "other"'s member providers together. */
  const seriesTokens = (day: UsageDayRow, s: UsageChartSeries): number =>
    day.byProvider.filter((p) => s.providers.includes(p.provider)).reduce((sum, p) => sum + p.tokens, 0)

  const dayTotal = (day: UsageDayRow): number => day.byProvider.reduce((sum, p) => sum + p.tokens, 0)

  if (days.length === 0) return null

  const max = Math.max(...days.map(dayTotal), 1) * 1.08
  const innerW = WIDTH - LEFT - RIGHT
  const innerH = HEIGHT - TOP - BOTTOM
  const step = innerW / days.length
  const barW = Math.max(2, Math.min(22, step - 2))
  const ticks = [0, 0.5, 1].map((f) => f * max)
  const everyNth = Math.ceil(days.length / 6)
  const hovered = hoverIndex !== null ? days[hoverIndex] : null

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: s.color }} />
            {s.label} <span className="tabular-nums">{formatTokenCount(days.reduce((sum, d) => sum + seriesTokens(d, s), 0))}</span>
          </span>
        ))}
        <button type="button" className="ml-auto text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'View as chart' : 'View as table'}
        </button>
      </div>

      {showTable ? (
        <div className="rounded-lg border border-border bg-card overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="text-left font-medium px-3 py-2">Day</th>
                {series.map((s) => <th key={s.key} className="text-right font-medium px-3 py-2">{s.label}</th>)}
                <th className="text-right font-medium px-3 py-2">Total</th>
              </tr>
            </thead>
            <tbody>
              {days.slice().reverse().slice(0, 14).map((day) => (
                <tr key={day.day} className="border-t border-border">
                  <td className="px-3 py-2">{fmtDate(day.day)}</td>
                  {series.map((s) => <td key={s.key} className="px-3 py-2 text-right tabular-nums">{formatTokenCount(seriesTokens(day, s))}</td>)}
                  <td className="px-3 py-2 text-right tabular-nums font-medium">{formatTokenCount(dayTotal(day))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Tokens per day by harness" className="block w-full h-auto overflow-visible">
            {ticks.map((v) => {
              const y = TOP + innerH - (v / max) * innerH
              return (
                <g key={v}>
                  <line x1={LEFT} x2={WIDTH - RIGHT} y1={y} y2={y} stroke="currentColor" strokeOpacity={0.15} strokeWidth={1} />
                  <text x={LEFT - 8} y={y + 4} textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">
                    {v === 0 ? '0' : formatTokenCount(v)}
                  </text>
                </g>
              )
            })}
            {days.map((day, i) => {
              const x = LEFT + i * step + (step - barW) / 2
              let y = TOP + innerH
              const active = series.filter((s) => seriesTokens(day, s) > 0)
              return (
                <g key={day.day}>
                  {active.map((s) => {
                    const hgt = (seriesTokens(day, s) / max) * innerH
                    const segY = y - hgt
                    y = segY
                    return <rect key={s.key} x={x} y={segY} width={barW} height={Math.max(0, hgt)} fill={s.color} />
                  })}
                  <rect
                    x={LEFT + i * step}
                    y={TOP}
                    width={step}
                    height={innerH}
                    fill="transparent"
                    onMouseEnter={() => setHoverIndex(i)}
                    onMouseLeave={() => setHoverIndex((cur) => (cur === i ? null : cur))}
                  />
                </g>
              )
            })}
            {days.map((day, i) => (i % everyNth === 0 || i === days.length - 1) ? (
              <text
                key={day.day}
                x={LEFT + i * step + step / 2}
                y={HEIGHT - 5}
                textAnchor={i === days.length - 1 ? 'end' : 'middle'}
                className="fill-muted-foreground text-[11px] tabular-nums"
              >
                {fmtDate(day.day)}
              </text>
            ) : null)}
          </svg>
          {hovered && (
            <div className="absolute top-1 right-1 min-w-[170px] rounded-lg border border-border bg-popover px-2.5 py-2 text-xs shadow-lg pointer-events-none">
              <div className="font-semibold mb-1">{fmtDate(hovered.day)}</div>
              {series.map((s) => (
                <div key={s.key} className="flex justify-between gap-3 text-muted-foreground">
                  <span><i className="inline-block h-2 w-2 rounded-[2px] mr-1.5" style={{ background: s.color }} />{s.label}</span>
                  <span className="tabular-nums">{formatTokenCount(seriesTokens(hovered, s))}</span>
                </div>
              ))}
              <div className="flex justify-between gap-3 border-t border-border mt-1 pt-1">
                <span>Total</span>
                <span className="tabular-nums">{formatTokenCount(dayTotal(hovered))}, about {formatUsd(hovered.costUsd)}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
