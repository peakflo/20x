import { useState, type KeyboardEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { CODING_AGENTS } from '@/types'
import {
  contextUsageLevel,
  formatContextTokens,
  type ContextUsageSnapshot
} from '@shared/context-usage'
import { USAGE_LEVEL_BAR, USAGE_LEVEL_TEXT } from '@/components/usage/usage-level-style'

interface ContextWindowMeterProps {
  usage: ContextUsageSnapshot | null
  /** Asks the harness to compact the conversation. Omit to hide the action. */
  onCompact?: () => void
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function codingAgentLabel(codingAgent: string | null): string {
  if (!codingAgent) return '—'
  return CODING_AGENTS.find((agent) => agent.value === codingAgent)?.label ?? codingAgent
}

/**
 * Header meter showing how full the task's agent context window is. The pill
 * shows a bar and the percentage; hover or focus opens the details card, which
 * holds the compact action.
 */
export function ContextWindowMeter({ usage, onCompact }: ContextWindowMeterProps) {
  const [open, setOpen] = useState(false)

  if (!usage || usage.usedTokens == null) return null

  const { usedTokens, maxTokens, percent, compacting, canCompact } = usage
  const hasWindow = maxTokens != null && percent != null
  const level = contextUsageLevel(percent)
  const roundedPercent = percent == null ? null : Math.round(percent)
  const barWidth = percent == null ? 0 : Math.min(100, Math.max(0, percent))
  const usedLabel = formatContextTokens(usedTokens)

  const summary = hasWindow
    ? `${usedLabel} of ${formatContextTokens(maxTokens)} tokens (${roundedPercent}%)`
    : `${usedLabel} tokens`
  const label = compacting ? `Context window: ${summary}, compacting` : `Context window: ${summary}`

  const showCompact = canCompact && !!onCompact

  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === 'Escape') setOpen(false)
  }

  return (
    <span
      className="relative flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onBlur={(event) => {
        // Keep the card open while focus moves between the pill and the compact button.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        data-testid="context-window-meter"
        onFocus={() => setOpen(true)}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-0.5 text-xs font-mono hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40',
          USAGE_LEVEL_TEXT[level]
        )}
      >
        {compacting ? (
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        ) : null}
        {hasWindow ? (
          <span className="h-1 w-12 rounded-full bg-muted overflow-hidden" aria-hidden>
            <span className={cn('block h-full rounded-full transition-all', USAGE_LEVEL_BAR[level])} style={{ width: `${barWidth}%` }} />
          </span>
        ) : null}
        <span>
          {compacting
            ? 'Compacting…'
            : hasWindow
              ? `${usedLabel} / ${formatContextTokens(maxTokens)} · ${roundedPercent}%`
              : `${usedLabel} tokens`}
        </span>
      </button>
      {open && (
        // Bottom padding bridges the gap so the pointer can move onto the card.
        <span className="absolute bottom-full right-0 z-50 pb-1.5 text-left leading-normal whitespace-normal" role="tooltip">
          <span className="block w-56 rounded-md border border-border bg-card p-3 text-xs shadow-lg space-y-1.5">
            <span className="block font-medium text-foreground">Context window</span>
            <Row label="Used" value={`${usedLabel} tokens`} />
            <Row label="Window" value={maxTokens != null ? `${formatContextTokens(maxTokens)} tokens` : 'Unknown'} />
            <Row label="Usage" value={roundedPercent != null ? `${roundedPercent}%` : '—'} />
            <Row label="Model" value={usage.model ?? '—'} />
            <Row label="Agent" value={codingAgentLabel(usage.codingAgent)} />
            <Row label="Updated" value={formatUpdatedAt(usage.updatedAt)} />
            {showCompact && (
              <Button
                variant="outline"
                size="sm"
                className="mt-1 h-7 w-full text-xs"
                disabled={compacting}
                onClick={onCompact}
              >
                {compacting ? 'Compacting…' : 'Compact context'}
              </Button>
            )}
          </span>
        </span>
      )}
    </span>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground truncate">{value}</span>
    </span>
  )
}
