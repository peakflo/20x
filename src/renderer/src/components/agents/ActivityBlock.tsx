/**
 * One agent turn's activity, folded into a single line.
 *
 *   Worked for 1m 12s · 12 steps · 5 file reads · 3 commands     ›
 *
 * While the turn runs, the line is the agent's latest note and a ticking clock.
 * Opening it lists the steps with the transcript's own row renderers (tool
 * rows, thinking, todos), so every detail view is the one people already know.
 * A failure the agent did not recover from adds one red line under the header,
 * with "Details" to open the block. Grouping rules live in
 * `@shared/transcript-activity` and are shared with the mobile transcript.
 */
import React, { useEffect, useId, useMemo, useState } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  blockSummary,
  failureSummary,
  unrecoveredFailure,
  type ActivityBlock as ActivityBlockModel,
  type ActivityMessageLike
} from '@shared/transcript-activity'

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

export interface ActivityBlockProps<M extends ActivityMessageLike> {
  block: ActivityBlockModel<M>
  open: boolean
  onOpenChange: (blockId: string, open: boolean) => void
  running: boolean
  /** Renders one step with the transcript's row renderer. */
  renderStep: (message: M) => React.ReactNode
  /** Content that stays visible below the header, e.g. artifact cards. */
  children?: React.ReactNode
}

export function ActivityBlock<M extends ActivityMessageLike>({
  block,
  open,
  onOpenChange,
  running,
  renderStep,
  children
}: ActivityBlockProps<M>): React.JSX.Element {
  const bodyId = useId()
  const now = useNow(running)
  const summary = blockSummary(block, { running, nowMs: now })
  const failure = useMemo(() => unrecoveredFailure(block), [block])

  return (
    <div data-testid="activity-block" data-running={running || undefined} className="w-full min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => onOpenChange(block.id, !open)}
        className="group/activity flex h-6 w-full min-w-0 items-center gap-2 rounded-sm px-1 text-left text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn('h-3 w-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none', open && 'rotate-90')}
        />
        {running && <Loader2 aria-hidden="true" className="h-3 w-3 shrink-0 animate-spin" />}
        <span className="min-w-0 flex-1 truncate">
          <span className="text-foreground/80">{summary.title}</span>
          {summary.detail && <span className="text-muted-foreground"> · {summary.detail}</span>}
        </span>
        {summary.elapsed && (
          <span aria-hidden="true" className="shrink-0 tabular-nums text-muted-foreground">
            {summary.elapsed}
          </span>
        )}
      </button>
      {failure && !open && (
        <p data-testid="activity-failure" className="flex min-w-0 items-center gap-2 pl-6 text-[11px] text-red-400">
          <span className="min-w-0 truncate">{failureSummary(failure)}</span>
          <button
            type="button"
            onClick={() => onOpenChange(block.id, true)}
            aria-controls={bodyId}
            className="shrink-0 font-medium underline underline-offset-2 hover:no-underline"
          >
            Details
          </button>
        </p>
      )}
      <div id={bodyId} role="group" aria-label="Agent steps" hidden={!open}>
        {open && (
          <div className="ml-2.5 mt-0.5 border-l border-border/30 pl-2 py-0.5">
            {block.messages.map((message) => (
              <React.Fragment key={message.id}>
                {block.noteIds.has(message.id) ? (
                  <p data-testid="activity-note" className="whitespace-pre-wrap break-words px-1 py-0.5 text-xs text-muted-foreground">
                    {message.content}
                  </p>
                ) : (
                  renderStep(message)
                )}
              </React.Fragment>
            ))}
          </div>
        )}
      </div>
      {children}
    </div>
  )
}
