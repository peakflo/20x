import { useEffect, useMemo, useState } from 'react'
import { ListChecks } from 'lucide-react'
import { useTaskStore } from '@/stores/task-store'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { TaskStatus } from '@/types'
import { isSnoozed } from '@/lib/utils'

/**
 * Slim always-visible strip at the bottom of the shell: live agent + task
 * counts on the left, app version on the right. Read-only.
 */
export function StatusBar() {
  const tasks = useTaskStore((s) => s.tasks)
  const sessions = useAgentStore((s) => s.sessions)
  const [version, setVersion] = useState('')

  useEffect(() => {
    window.electronAPI?.app?.getVersion().then((v) => v && setVersion(v))
  }, [])

  const runningAgents = useMemo(() => {
    let n = 0
    for (const s of sessions.values()) if (s.status !== SessionStatus.IDLE) n++
    return n
  }, [sessions])

  const { active, total } = useMemo(() => {
    let a = 0
    let t = 0
    for (const task of tasks) {
      if (task.parent_task_id) continue
      t++
      if (task.status !== TaskStatus.Completed && !isSnoozed(task.snoozed_until)) a++
    }
    return { active: a, total: t }
  }, [tasks])

  return (
    <div className="bg-background flex-shrink-0 flex items-center gap-4 h-6 px-3 text-[11px] text-muted-foreground select-none tabular-nums">
      <span className="flex items-center gap-1.5" title={`${runningAgents} agent session${runningAgents !== 1 ? 's' : ''} running`}>
        <span
          className={`h-1.5 w-1.5 rounded-full ${runningAgents > 0 ? 'bg-primary animate-pulse' : 'bg-muted-foreground/40'}`}
        />
        {runningAgents} running
      </span>
      <span className="flex items-center gap-1.5" title="Active · total top-level tasks">
        <ListChecks className="h-3 w-3" />
        {active} active · {total} total
      </span>
      <div className="flex-1" />
      {version && <span className="opacity-70">v{version}</span>}
    </div>
  )
}
