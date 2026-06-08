import { Check, X, Loader2, AlertTriangle } from 'lucide-react'
import { useProgressToastStore, type ProgressToast } from '@/stores/progress-toast-store'

function ProgressToastItem({ toast }: { toast: ProgressToast }) {
  const { dismiss, remove } = useProgressToastStore()

  const isError = toast.status === 'error'
  const isDone = toast.status === 'done'

  return (
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
            {toast.title}
          </span>
        </div>
        <button
          type="button"
          onClick={() => (isError || isDone ? remove(toast.id) : dismiss(toast.id))}
          className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {/* Status message */}
      {toast.message && (
        <p className="text-[11px] text-muted-foreground mb-2 truncate">{toast.message}</p>
      )}

      {/* Progress bar (hidden when error/done) */}
      {!isError && !isDone && (
        <div className="h-1 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
            style={{ width: `${Math.max(toast.percent, 2)}%` }}
          />
        </div>
      )}
    </div>
  )
}

/**
 * Renders all active progress toasts as a vertical stack at the bottom-right.
 * Mount once in the root layout (e.g. AppLayout).
 */
export function ProgressToastStack() {
  const toasts = useProgressToastStore((s) => s.toasts)

  const visible = Array.from(toasts.values())
    .filter((t) => !t.dismissed)
    .sort((a, b) => a.createdAt - b.createdAt)

  if (visible.length === 0) return null

  return (
    <div className="fixed bottom-5 right-5 z-50 w-80 flex flex-col gap-2 animate-in fade-in slide-in-from-bottom-3 duration-300">
      {visible.map((t) => (
        <ProgressToastItem key={t.id} toast={t} />
      ))}
    </div>
  )
}
