import { useEffect, useState } from 'react'
import { Gauge, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { SettingsSection } from '../SettingsSection'
import { useSubscriptionUsage } from '@/hooks/use-subscription-usage'
import { useUsageParallelism } from '@/hooks/use-usage-parallelism'
import { useUsageCardName } from '@/hooks/use-usage-card-name'
import { useThemeStore } from '@/stores/theme-store'
import { ProviderLimitsCard } from '@/components/usage/ProviderLimitsCard'
import { ModelPricesDialog } from '@/components/usage/ModelPricesDialog'
import { UsageHeroCard } from '@/components/usage/UsageHeroCard'
import { ShareUsageDialog } from '@/components/usage/ShareUsageDialog'
import { TokensPerDayChart } from '@/components/usage/TokensPerDayChart'
import { Switch } from '@/components/ui/Switch'
import { Label } from '@/components/ui/Label'
import { settingsApi, usageApi } from '@/lib/ipc-client'
import { AUTO_RESUME_LIMITED_TASKS_SETTING, isAutoResumeSettingEnabled } from '@shared/usage-limit-recovery'
import {
  USAGE_PROVIDER_LABELS,
  costSourceTooltip,
  formatMultiplier,
  formatTokenCount,
  formatUsd,
  totalTokens,
  usageCostHint,
  usagePeriodForParallelismDays,
  type UsageModelRow,
  type UsageParallelismPeriod
} from '@shared/usage'
import { buildUsageCardSummary, usagePeriodLabel, type UsageCardSummary } from '@shared/usage-card'

const PERIOD_OPTIONS: Array<{ days: UsageParallelismPeriod; label: string }> = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 182, label: '6 months' }
]

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold text-foreground tabular-nums">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

/** Small superscript marker next to a cost that was estimated or set by the user, rather than reported by the harness. */
function CostSourceMarker({ source }: { source: UsageModelRow['costSource'] }) {
  const tooltip = costSourceTooltip(source)
  if (!tooltip) return null
  return (
    <span className="ml-1 text-[9px] font-semibold text-muted-foreground align-super cursor-help" title={tooltip}>
      {source === 'custom' ? '✎' : '≈'}
    </span>
  )
}

/** Per-model cost cell: the amount with a source marker, or "No price" + a "Set price" action when nothing is known. */
function ModelCostCell({ row, onSetPrice }: { row: UsageModelRow; onSetPrice: (model: string) => void }) {
  if (row.costSource === 'unpriced') {
    return (
      <button
        type="button"
        className="text-[11px] text-primary hover:underline"
        onClick={() => onSetPrice(row.model)}
      >
        No price · Set price
      </button>
    )
  }
  return (
    <span>
      {formatUsd(row.costUsd)}
      <CostSourceMarker source={row.costSource} />
    </span>
  )
}

function AutoResumeSetting() {
  const [enabled, setEnabled] = useState(true)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    settingsApi.get(AUTO_RESUME_LIMITED_TASKS_SETTING)
      .then((value) => setEnabled(isAutoResumeSettingEnabled(value)))
      .catch(() => undefined)
      .finally(() => setLoaded(true))
  }, [])

  const handleChange = (checked: boolean): void => {
    setEnabled(checked)
    void settingsApi.set(AUTO_RESUME_LIMITED_TASKS_SETTING, checked ? 'true' : 'false')
  }

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3">
      <div className="space-y-0.5">
        <Label htmlFor="auto-resume-limited-tasks">Continue automatically after a limit reset</Label>
        <p className="text-xs text-muted-foreground">
          When an agent stops because a plan limit was reached, send "Continue where you left off." once the
          limit resets. Each task can cancel its scheduled continuation.
        </p>
      </div>
      <Switch
        id="auto-resume-limited-tasks"
        checked={enabled}
        onCheckedChange={handleChange}
        disabled={!loaded}
      />
    </div>
  )
}

export function UsageSettings() {
  const [periodDays, setPeriodDays] = useState<UsageParallelismPeriod>(30)
  const period = usagePeriodForParallelismDays(periodDays)
  const { limits, summary, loading, refreshing, error, refreshLimits, runLimitsAction, reloadSummary } = useSubscriptionUsage(period)
  const parallelism = useUsageParallelism(periodDays)
  const cardName = useUsageCardName()
  const resolvedTheme = useThemeStore((s) => s.resolved)

  const [pricesDialogOpen, setPricesDialogOpen] = useState(false)
  const [prefillModel, setPrefillModel] = useState<string | null>(null)
  const [ratesRefreshing, setRatesRefreshing] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)

  const openSetPrice = (model: string): void => {
    setPrefillModel(model)
    setPricesDialogOpen(true)
  }

  const handleRefresh = async (): Promise<void> => {
    setRatesRefreshing(true)
    try {
      await Promise.all([refreshLimits(), usageApi.refreshRates({ force: true })])
      await reloadSummary()
    } finally {
      setRatesRefreshing(false)
    }
  }

  const totals = summary?.totals
  const periodTokens = totals ? totalTokens(totals) : 0
  const periodLabel = usagePeriodLabel(periodDays)

  // The calendar's per-day value comes from the SAME summary.byDay the
  // tokens-per-day chart below reads (see usage-card.ts's module docstring)
  // — [] when the token summary hasn't loaded yet is fine, it just means
  // every calendar cell starts at 0 until it does.
  const cardBuild = parallelism.data ? buildUsageCardSummary(parallelism.data, summary?.byDay ?? [], periodTokens, periodLabel) : null
  const cardSummary: UsageCardSummary | null = cardBuild?.summary ?? null

  const records: Array<[string, string]> = []
  if (cardSummary) {
    // "Most agents at once" is a plain aggregate (live + backfilled), always shown whenever there's any agent-run data.
    records.push(['Most agents at once', `${cardSummary.peakDay.peak} on ${new Date(cardSummary.peakDay.atMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`])
    // The multiplier/hours-based records are ratio-derived — only shown once the ratio itself is ready (both null together, never independently).
    if (cardSummary.multiplier !== null) {
      const multiplierText = formatMultiplier(cardSummary.multiplier)
      // formatMultiplier already includes the "×" for the capped ">1000×" case — every other branch returns the bare number.
      records.push(['Agents in parallel, on average', multiplierText.endsWith('×') ? multiplierText : `${multiplierText}×`])
    }
    if (cardSummary.hours !== null && cardSummary.wall !== null) {
      records.push(['Agent work done', `${Math.round(cardSummary.hours).toLocaleString('en-US')} hours in ${Math.round(cardSummary.wall).toLocaleString('en-US')}`])
    }
  }
  if (summary && summary.byDay.length > 0) {
    const biggest = summary.byDay.reduce((a, d) => (totalTokens(d) > totalTokens(a) ? d : a), summary.byDay[0])
    if (totalTokens(biggest) > 0) {
      const label = new Date(`${biggest.day}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      records.push(['Busiest day by tokens', `${formatTokenCount(totalTokens(biggest))} on ${label}`])
    }
  }

  return (
    <>
      <SettingsSection title="Usage" description="">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="inline-flex items-center gap-1 rounded-full border border-border bg-card p-1" role="tablist" aria-label="Period">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.days}
                type="button"
                role="tab"
                aria-selected={periodDays === opt.days}
                onClick={() => setPeriodDays(opt.days)}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium rounded-full transition-colors',
                  periodDays === opt.days ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <Button size="sm" onClick={() => setShareOpen(true)}>
            Share
          </Button>
        </div>

        <UsageHeroCard
          data={parallelism.data}
          byDay={summary?.byDay ?? []}
          loading={parallelism.loading}
          tokens={periodTokens}
          periodLabel={periodLabel}
          name={cardName.name}
          onOpenShare={() => setShareOpen(true)}
        />
        <p className="text-xs text-muted-foreground px-0.5">
          The multiplier is how much agent work got done per hour you spent in 20x: total agent run time divided
          by your screen time in the app.
        </p>
      </SettingsSection>

      <SettingsSection
        title="Subscription limits"
        description="How much of each subscription plan window is used, as reported by the provider. Updated as agents run."
      >
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Only subscription logins report plan limits (Claude Pro/Max/Team, ChatGPT plans, Cursor, OpenCode Go).
          </p>
          <Button size="sm" variant="outline" onClick={() => void handleRefresh()} disabled={refreshing || ratesRefreshing}>
            <RefreshCw className={cn('h-3.5 w-3.5', (refreshing || ratesRefreshing) && 'animate-spin')} />
            {refreshing || ratesRefreshing ? 'Checking…' : 'Refresh'}
          </Button>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <AutoResumeSetting />

        {limits.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {limits.map((providerLimits) => (
              <ProviderLimitsCard
                key={providerLimits.instanceId ?? providerLimits.provider}
                limits={providerLimits}
                onAction={(actionId) => void runLimitsAction(actionId)}
                actionPending={refreshing}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-8 text-center border border-dashed border-border rounded-lg">
            <Gauge className="h-8 w-8 text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground mb-1">
              {loading || refreshing ? 'Checking plan limits…' : 'No plan limits yet'}
            </p>
            <p className="text-xs text-muted-foreground">
              Add an agent that signs in with a subscription (Claude Code, Codex, Cursor, OpenCode Go), then refresh or run a task.
            </p>
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="Token usage"
        description="Tokens consumed by agent turns in 20x, including subagents. Cost is an API-equivalent estimate — not your subscription bill — priced from the provider's own report where given, and from public rates (or a custom price) otherwise."
      >
        <div className="flex items-center justify-end">
          <Button size="sm" variant="outline" onClick={() => { setPrefillModel(null); setPricesDialogOpen(true) }}>
            Model prices
          </Button>
        </div>

        {!totals || totals.records === 0 ? (
          <p className="text-xs text-muted-foreground py-4">
            No token usage recorded in this period. Usage is recorded for every agent harness as its turns complete.
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
              <StatTile label="Est. cost" value={formatUsd(totals.costUsd)} hint={usageCostHint(totals)} />
            </div>

            {totals.cacheSavingsUsd !== null && totals.cacheSavingsUsd > 0 && (
              <p className="text-[11px] text-muted-foreground">
                Cache reads saved an estimated {formatUsd(totals.cacheSavingsUsd)} vs. paying the input rate.
              </p>
            )}

            {summary && (
              <div className="rounded-lg border border-border bg-card p-4">
                <TokensPerDayChart days={summary.byDay} colorScheme={resolvedTheme} />
              </div>
            )}
          </>
        )}
      </SettingsSection>

      <div className="grid gap-3 sm:grid-cols-2">
        {summary && summary.topTasks.length > 0 && (
          <SettingsSection title="Top tasks" description="Where the tokens and the cost went">
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <table className="w-full text-xs">
                <tbody>
                  {summary.topTasks.map((row) => (
                    <tr key={row.taskId} className="border-t border-border first:border-t-0">
                      <td className="px-3 py-2 text-foreground truncate max-w-[16rem]">{row.title ?? 'Deleted task'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatTokenCount(totalTokens(row))}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatUsd(row.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SettingsSection>
        )}

        {records.length > 0 && (
          <SettingsSection title="Records in this period" description="Your personal bests">
            <ul className="divide-y divide-border rounded-lg border border-border bg-card">
              {records.map(([label, value]) => (
                <li key={label} className="flex items-center justify-between gap-3 px-3 py-2.5 text-xs">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-semibold tabular-nums">{value}</span>
                </li>
              ))}
            </ul>
          </SettingsSection>
        )}
      </div>

      {summary && summary.byModel.length > 0 && (
        <SettingsSection title="Models" description="Cost is the provider's figure where it reports one, otherwise estimated from public API rates">
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
                    <td className="px-3 py-2 text-right tabular-nums">
                      <ModelCostCell row={row} onSetPrice={openSetPrice} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SettingsSection>
      )}

      <ModelPricesDialog
        open={pricesDialogOpen}
        onOpenChange={setPricesDialogOpen}
        initialModel={prefillModel}
      />

      <ShareUsageDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        summary={cardSummary}
        periodDaysLabel={`${periodDays}d`}
        name={cardName.name}
        onNameChange={cardName.setName}
      />
    </>
  )
}
