import { useEffect, useState } from 'react'
import { GitPullRequest } from 'lucide-react'
import { Switch } from '@/components/ui/Switch'
import { useTaskStore } from '@/stores/task-store'
import { settingsApi } from '@/lib/ipc-client'
import { PR_WATCH_ENABLED_SETTING } from '@shared/pull-request-watch-settings'
import type { WorkfloTask } from '@/types'

interface PullRequestWatchToggleProps {
  task: WorkfloTask
}

/**
 * Per-task "Watch PR" switch in the task properties grid. The switch sets this
 * task's own choice. Until it is set, the task follows the global setting in
 * Settings → General.
 */
export function PullRequestWatchToggle({ task }: PullRequestWatchToggleProps) {
  const updateTask = useTaskStore((state) => state.updateTask)
  const [globalEnabled, setGlobalEnabled] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const value = await settingsApi.get(PR_WATCH_ENABLED_SETTING)
        if (!cancelled) setGlobalEnabled(value !== 'false')
      } catch {
        // Keep the default (enabled) when the setting cannot be read.
      }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  const followsGlobal = task.pr_watch_enabled == null
  const enabled = task.pr_watch_enabled ?? globalEnabled

  return (
    <>
      <span className="text-muted-foreground flex items-center gap-2">
        <GitPullRequest className="h-3.5 w-3.5" /> Watch PR
      </span>
      <div className="flex items-center gap-2">
        <Switch
          aria-label="Watch pull request"
          checked={enabled}
          onCheckedChange={(checked) => { void updateTask(task.id, { pr_watch_enabled: checked }) }}
        />
        <span className="text-xs text-muted-foreground">
          {followsGlobal ? `Follows setting (${globalEnabled ? 'on' : 'off'})` : enabled ? 'On for this task' : 'Off for this task'}
        </span>
      </div>
    </>
  )
}
