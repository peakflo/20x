import { useEffect } from 'react'
import { Check, X, Loader2, AlertTriangle } from 'lucide-react'
import { useSetupProgressStore } from '@/stores/setup-progress-store'

/**
 * Floating toast that shows background agent setup progress.
 * Renders at the bottom-right, stays visible until complete or dismissed.
 */
export function SetupProgressToast() {
  const { active, phase, message, percent, dismissed, dismiss, reset } =
    useSetupProgressStore()

  // Auto-dismiss 4s after completion
  useEffect(() => {
    if (phase === 'done') {
      const t = setTimeout(() => reset(), 4000)
      return () => clearTimeout(t)
    }
    return undefined
  }, [phase, reset])

  if (!active || dismissed) return null

  const isError = phase === 'error'
  const isDone = phase === 'done'

  return (
    <div className="fixed bottom-5 right-5 z-50 w-80 animate-in fade-in slide-in-from-bottom-3 duration-300">
      <div
        className={`rounded-lg border shadow-lg backdrop-blur-sm px-4 py-3 ${
          isError
            ? 'bg-destructive/10 border-destructive/30'
            : isDone
              ? 'bg-emerald-500/10 border-emerald-500/30'
              : 'bg-card border-border'
        }`}
      >
        {/* Header row */}
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-2 min-w-0">
            {isError ? (
              <AlertTriangle className="size-3.5 text-destructive shrink-0" />
            ) : isDone ? (
              <Check className="size-3.5 text-emerald-400 shrink-0" />
            ) : (
              <Loader2 className="size-3.5 animate-spin text-primary shrink-0" />
            )}
            <span className="text-xs font-medium text-foreground truncate">
              {isDone ? 'Setup complete' : isError ? 'Setup failed' : 'Setting up agent'}
            </span>
          </div>
          <button
            type="button"
            onClick={isError || isDone ? reset : dismiss}
            className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <X className="size-3.5" />
          </button>
        </div>

        {/* Status message */}
        <p className="text-[11px] text-muted-foreground mb-2 truncate">{message}</p>

        {/* Progress bar (hidden when error/done) */}
        {!isError && !isDone && (
          <div className="h-1 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
              style={{ width: `${Math.max(percent, 2)}%` }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
