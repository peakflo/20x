import { useState } from 'react'
import {
  COMPACT_COMMAND,
  contextUsageLevel,
  formatContextTokens,
  type ContextUsageSnapshot
} from '@shared/context-usage'

/** Primary below 70%, yellow 70–90%, red above 90% (matches the shared thresholds). */
const LEVEL_BAR = {
  normal: 'bg-primary',
  warning: 'bg-yellow-400',
  critical: 'bg-red-500'
} as const

const LEVEL_TEXT = {
  normal: 'text-muted-foreground',
  warning: 'text-yellow-300',
  critical: 'text-red-400'
} as const

function formatUpdatedAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * How full the task's agent context window is. Compact pill that toggles a
 * details panel; the panel offers "Compact context" when the harness supports it.
 * Renders nothing until the snapshot reports how many tokens are in use.
 */
export function ContextWindowMeter({ usage, onCompact }: { usage: ContextUsageSnapshot | null; onCompact?: () => void }) {
  const [open, setOpen] = useState(false)

  if (!usage || usage.usedTokens == null) return null

  const used = formatContextTokens(usage.usedTokens)
  const hasMax = usage.maxTokens != null && usage.percent != null
  const percent = usage.percent ?? 0
  const level = contextUsageLevel(usage.percent)
  const label = hasMax
    ? `${used} / ${formatContextTokens(usage.maxTokens)} · ${Math.round(percent)}%`
    : `${used} used`
  const showCompact = usage.canCompact && !!onCompact

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`Context window: ${label}`}
        title="Context window"
        className={`flex items-center gap-2 min-h-10 px-2.5 rounded-md border border-border/50 bg-card text-xs tabular-nums active:opacity-60 hover:bg-white/5 transition-colors ${LEVEL_TEXT[level]}`}
      >
        {hasMax && (
          <span
            className="block w-12 h-1.5 rounded-full bg-muted overflow-hidden"
            role="meter"
            aria-valuenow={Math.round(percent)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Context window usage"
          >
            <span className={`block h-full rounded-full ${LEVEL_BAR[level]}`} style={{ width: `${Math.min(100, percent)}%` }} />
          </span>
        )}
        <span>{label}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 w-64 rounded-lg border border-border/50 bg-card p-3 shadow-lg space-y-2 text-xs">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
            <dt className="text-muted-foreground">Used</dt>
            <dd className="tabular-nums text-right">{formatContextTokens(usage.usedTokens)} tokens</dd>
            <dt className="text-muted-foreground">Window</dt>
            <dd className="tabular-nums text-right">{usage.maxTokens != null ? `${formatContextTokens(usage.maxTokens)} tokens` : 'Unknown'}</dd>
            <dt className="text-muted-foreground">Percent</dt>
            <dd className="tabular-nums text-right">{usage.percent != null ? `${Math.round(percent)}%` : '—'}</dd>
            <dt className="text-muted-foreground">Model</dt>
            <dd className="text-right truncate">{usage.model ?? '—'}</dd>
            <dt className="text-muted-foreground">Agent</dt>
            <dd className="text-right truncate">{usage.codingAgent ?? '—'}</dd>
            <dt className="text-muted-foreground">Updated</dt>
            <dd className="tabular-nums text-right">{formatUpdatedAt(usage.updatedAt)}</dd>
          </dl>

          {showCompact && (
            <button
              type="button"
              onClick={onCompact}
              disabled={usage.compacting}
              className="w-full min-h-10 inline-flex items-center justify-center gap-2 rounded-md bg-primary text-primary-foreground text-xs font-medium active:opacity-80 disabled:opacity-50 transition-opacity"
            >
              {usage.compacting ? (
                <>
                  <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  Compacting…
                </>
              ) : (
                'Compact context'
              )}
            </button>
          )}
          {showCompact && (
            <p className="text-[10px] text-muted-foreground/70">Sends {COMPACT_COMMAND} to the agent.</p>
          )}
        </div>
      )}
    </div>
  )
}
