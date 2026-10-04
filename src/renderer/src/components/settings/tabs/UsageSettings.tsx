import { useState } from 'react'
import { AlertTriangle, Gauge, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { SettingsSection } from '../SettingsSection'
import { useSubscriptionUsage } from '@/hooks/use-subscription-usage'
import {
  USAGE_PROVIDER_LABELS,
  effectiveUsedPercent,
  formatResetIn,
  formatTokenCount,
  formatUsd,
  totalTokens,
  usageLimitLevel,
  type ProviderUsageLimits,
  type UsageAggregate,
  type UsageDayRow,
  type UsageLimitWindow,
  type UsagePeriod
} from '@shared/usage'

const PERIODS: Array<{ value: UsagePeriod; label: string }> = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' }
]

const LEVEL_BAR: Record<ReturnType<typeof usageLimitLevel>, string> = {
  normal: 'bg-primary',
  warning: 'bg-warning',
  critical: 'bg-destructive'
}

function formatPlan(planType: string | null | undefined): string | null {
  if (!planType) return null
  return planType.charAt(0).toUpperCase() + planType.slice(1)
}

function formatCheckedAt(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const minutes = Math.round((Date.now() - ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(ms).toLocaleDateString()
}

function LimitWindowRow({ window }: { window: UsageLimitWindow }) {
  const used = effectiveUsedPercent(window)
  const level = usageLimitLevel(used)
  const resetIn = formatResetIn(window.resetsAt)
  return (
    <div className="space-y-1.5" data-testid={`usage-window-${window.id}`}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium text-foreground">{window.label}</span>
        <span className="text-muted-foreground tabular-nums">
          {Math.round(used)}% used{resetIn ? ` · resets ${resetIn}` : ''}
        </span>
      </div>
      <div
        className="h-1.5 w-full rounded-full bg-muted overflow-hidden"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(used)}
        aria-label={`${window.label}: ${Math.round(used)}% used`}
      >
        <div className={cn('h-full rounded-full transition-[width]', LEVEL_BAR[level])} style={{ width: `${used}%` }} />
      </div>
    </div>
  )
}

function ProviderLimitsCard({ limits }: { limits: ProviderUsageLimits }) {
  const plan = formatPlan(limits.planType)
  const stale = limits.unavailable?.reason === 'probe_failed'
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3" data-testid={`usage-limits-${limits.provider}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold text-foreground">{USAGE_PROVIDER_LABELS[limits.provider]}</span>
          {plan && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">{plan}</span>
          )}
        </div>
        <span className="text-[11px] text-muted-foreground shrink-0">Checked {formatCheckedAt(limits.checkedAt)}</span>
      </div>

      {limits.limitReached && (
        <div className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>Limit reached — requests are blocked until the window resets.</span>
        </div>
      )}

      {limits.windows.length > 0 ? (
        <div className="space-y-3">
          {limits.windows.map((window) => <LimitWindowRow key={window.id} window={window} />)}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {limits.unavailable?.message ?? 'No plan limits reported yet.'}
        </p>
      )}

      {stale && limits.windows.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          Last refresh failed ({limits.unavailable?.message}); showing the previous reading.
        </p>
      )}
      {typeof limits.resetCreditsAvailable === 'number' && limits.resetCreditsAvailable > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {limits.resetCreditsAvailable} rate-limit reset credit{limits.resetCreditsAvailable === 1 ? '' : 's'} banked
        </p>
      )}
    </div>
  )
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold text-foreground tabular-nums">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

function costHint(aggregate: UsageAggregate): string | undefined {
  if (aggregate.records === 0) return undefined
  if (aggregate.unpricedRecords === aggregate.records) return 'not reported'
  if (aggregate.unpricedRecords > 0) return 'partial — Codex does not report cost'
  return 'API-equivalent estimate'
}

/** Single-series daily bars (tokens processed per day) with per-bar hover details. */
function DailyUsageBars({ days }: { days: UsageDayRow[] }) {
  const [hovered, setHovered] = useState<string | null>(null)
  if (days.length === 0) return null
  const max = Math.max(...days.map((d) => totalTokens(d)), 1)
  const active = days.find((d) => d.day === hovered) ?? null
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-2">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-foreground">Tokens per day</span>
        <span className="text-muted-foreground tabular-nums" aria-live="polite">
          {active
            ? `${active.day} · ${formatTokenCount(totalTokens(active))} tokens · ${formatUsd(active.costUsd)}`
            : `Peak ${formatTokenCount(max)}`}
        </span>
      </div>
      <div className="flex items-end gap-0.5 h-24" role="img" aria-label="Tokens processed per day">
        {days.map((day) => {
          const value = totalTokens(day)
          return (
            <button
              key={day.day}
              type="button"
              className="flex-1 h-full flex items-end focus-visible:outline-none group"
              onMouseEnter={() => setHovered(day.day)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(day.day)}
              onBlur={() => setHovered(null)}
              aria-label={`${day.day}: ${formatTokenCount(value)} tokens`}
            >
              <span
                className={cn(
                  'w-full rounded-t-[4px] bg-primary/70 group-hover:bg-primary group-focus-visible:bg-primary',
                  value > 0 && 'min-h-[2px]'
                )}
                style={{ height: `${(value / max) * 100}%` }}
              />
            </button>
          )
        })}
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>{days[0].day}</span>
        {days.length > 1 && <span>{days[days.length - 1].day}</span>}
      </div>
    </div>
  )
}

export function UsageSettings() {
  const [period, setPeriod] = useState<UsagePeriod>('7d')
  const { limits, summary, loading, refreshing, error, refreshLimits } = useSubscriptionUsage(period)
  const totals = summary?.totals

  return (
    <>
      <SettingsSection
        title="Subscription limits"
        description="How much of each Claude Code and Codex plan window is used, as reported by the provider. Updated as agents run."
      >
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Only subscription logins (Claude Pro/Max/Team, ChatGPT plans) report plan limits.
          </p>
          <Button size="sm" variant="outline" onClick={() => void refreshLimits()} disabled={refreshing}>
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            {refreshing ? 'Checking…' : 'Refresh'}
          </Button>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        {limits.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {limits.map((providerLimits) => (
              <ProviderLimitsCard key={providerLimits.provider} limits={providerLimits} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-8 text-center border border-dashed border-border rounded-lg">
            <Gauge className="h-8 w-8 text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground mb-1">
              {loading || refreshing ? 'Checking plan limits…' : 'No plan limits yet'}
            </p>
            <p className="text-xs text-muted-foreground">
              Add a Claude Code or Codex agent that signs in with a subscription, then refresh or run a task.
            </p>
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="Token usage"
        description="Tokens consumed by agent turns in 20x, including subagents. Cost is the provider-reported API-equivalent estimate — subscription plans bill separately."
      >
        <div className="flex items-center gap-1" role="tablist" aria-label="Usage period">
          {PERIODS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={period === option.value}
              onClick={() => setPeriod(option.value)}
              className={cn(
                'px-3 py-1 text-xs font-medium rounded-md transition-colors',
                period === option.value
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        {!totals || totals.records === 0 ? (
          <p className="text-xs text-muted-foreground py-4">
            No token usage recorded in this period. Usage is recorded for Claude Code and Codex agents as their turns complete.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <StatTile label="Total tokens" value={formatTokenCount(totalTokens(totals))} />
              <StatTile label="Input" value={formatTokenCount(totals.inputTokens)} hint="uncached" />
              <StatTile
                label="Cache"
                value={formatTokenCount(totals.cacheReadTokens + totals.cacheWriteTokens)}
                hint={`${formatTokenCount(totals.cacheReadTokens)} read · ${formatTokenCount(totals.cacheWriteTokens)} write`}
              />
              <StatTile label="Output" value={formatTokenCount(totals.outputTokens)} hint={totals.reasoningTokens > 0 ? `${formatTokenCount(totals.reasoningTokens)} reasoning` : undefined} />
              <StatTile label="Est. cost" value={formatUsd(totals.costUsd)} hint={costHint(totals)} />
            </div>

            {summary && <DailyUsageBars days={summary.byDay} />}

            {summary && summary.byModel.length > 0 && (
              <div className="rounded-lg border border-border bg-card overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                      <th className="text-left font-medium px-3 py-2">Model</th>
                      <th className="text-right font-medium px-3 py-2">Input</th>
                      <th className="text-right font-medium px-3 py-2">Cache read</th>
                      <th className="text-right font-medium px-3 py-2">Cache write</th>
                      <th className="text-right font-medium px-3 py-2">Output</th>
                      <th className="text-right font-medium px-3 py-2">Est. cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byModel.map((row) => (
                      <tr key={`${row.provider}:${row.model}`} className="border-t border-border">
                        <td className="px-3 py-2">
                          <div className="font-medium text-foreground truncate">{row.model}</div>
                          <div className="text-[10px] text-muted-foreground">{USAGE_PROVIDER_LABELS[row.provider]}</div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatTokenCount(row.inputTokens)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatTokenCount(row.cacheReadTokens)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatTokenCount(row.cacheWriteTokens)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatTokenCount(row.outputTokens)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatUsd(row.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {summary && summary.topTasks.length > 0 && (
              <div className="rounded-lg border border-border bg-card overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                      <th className="text-left font-medium px-3 py-2">Top tasks</th>
                      <th className="text-right font-medium px-3 py-2">Tokens</th>
                      <th className="text-right font-medium px-3 py-2">Est. cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.topTasks.map((row) => (
                      <tr key={row.taskId} className="border-t border-border">
                        <td className="px-3 py-2 text-foreground truncate max-w-[22rem]">{row.title ?? 'Deleted task'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatTokenCount(totalTokens(row))}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatUsd(row.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </SettingsSection>
    </>
  )
}
