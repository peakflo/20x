import { useState, useEffect } from 'react'
import { Loader2, CheckCircle, XCircle } from 'lucide-react'
import { onWorktreeProgress } from '@/lib/ipc-client'
import type { WorktreeProgressEvent } from '@/types/electron'

interface RepoProgress {
  repo: string
  step: string
  done: boolean
  error?: string
}

interface WorktreeProgressOverlayProps {
  taskId: string | null
  visible: boolean
}

export function WorktreeProgressOverlay({ taskId, visible }: WorktreeProgressOverlayProps) {
  const [progress, setProgress] = useState<Map<string, RepoProgress>>(new Map())

  useEffect(() => {
    if (!visible) {
      setProgress(new Map())
      return
    }

    const cleanup = onWorktreeProgress((event: WorktreeProgressEvent) => {
      if (taskId && event.taskId && event.taskId !== taskId) return
      setProgress((prev) => {
        const next = new Map(prev)
        next.set(event.repo, {
          repo: event.repo,
          step: event.step,
          done: event.done,
          error: event.error
        })
        return next
      })
    })

    return cleanup
  }, [visible, taskId])

  if (!visible || progress.size === 0) return null

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-lg p-6 max-w-sm w-full shadow-lg space-y-3">
        <h3 className="text-sm font-medium">Setting up workspace...</h3>
        {[...progress.values()].map((p) => (
          <div key={p.repo} className="flex items-center gap-2.5 text-sm">
            {p.error ? (
              <XCircle className="h-4 w-4 text-destructive shrink-0" />
            ) : p.done ? (
              <CheckCircle className="h-4 w-4 text-green-400 shrink-0" />
            ) : (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
            )}
            <span className="truncate flex-1">{p.repo}</span>
            <span className="text-xs text-muted-foreground shrink-0">
              {p.error || p.step}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
