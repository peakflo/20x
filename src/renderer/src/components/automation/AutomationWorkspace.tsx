import { useEffect, useState } from 'react'
import { CalendarClock } from 'lucide-react'
import { useTaskStore } from '@/stores/task-store'
import { useTaskGroupStore } from '@/stores/task-group-store'
import { useUIStore } from '@/stores/ui-store'
import { taskWorkspaceId, WorkspaceBadge } from '@/components/ui/WorkspaceBadge'
import { TaskStatus } from '@/types'
import type { ResponsibilitySnapshot, ResponsibilityState } from '@shared/responsibilities'

const stateLabels: Record<ResponsibilityState, string> = {
  proposed: 'Awaiting approval', active: 'Active', paused: 'Paused', blocked: 'Blocked',
  taken_over: 'Taken over', completed: 'Completed', cancelled: 'Cancelled'
}

function dateLabel(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString()
}

export function AutomationWorkspace() {
  const tasks = useTaskStore(s => s.tasks)
  const tasksLoading = useTaskStore(s => s.isLoading)
  const tasksError = useTaskStore(s => s.error)
  const projectId = useUIStore(s => s.mastermindProjectId)
  const taskProjects = useUIStore(s => s.mastermindTaskProjects)
  const syncMastermindSnapshot = useUIStore(s => s.syncMastermindSnapshot)
  const groups = useTaskGroupStore(s => s.groups)
  const membership = useTaskGroupStore(s => s.membership)
  const [snapshot, setSnapshot] = useState<ResponsibilitySnapshot | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const api = window.electronAPI?.responsibilities
    if (!api) { setError('Project goals and routines are unavailable.'); return }
    let live = true
    let request = 0
    const refresh = async () => {
      const current = ++request
      try {
        const next = await api.snapshot()
        if (live && current === request) { setSnapshot(next); syncMastermindSnapshot(next); setError('') }
      } catch (e) {
        if (live && current === request) setError(`Could not refresh project goals and routines: ${String(e)}`)
      }
    }
    const off = api.onChanged(() => { void refresh() })
    void refresh()
    return () => { live = false; off() }
  }, [syncMastermindSnapshot])

  const workspaceForTask = (taskId: string) => taskWorkspaceId(taskId, taskProjects, groups, membership)
  const schedules = tasks.filter(t => t.is_recurring && !t.recurrence_parent_id && (!projectId || workspaceForTask(t.id) === projectId))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const work = (snapshot?.responsibilities ?? []).filter(r => (r.agreement.kind === 'goal' || r.agreement.kind === 'routine') && (!projectId || r.projectId === projectId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  return <div className="h-full overflow-auto p-6">
    <header className="mb-6">
      <h1 className="flex items-center gap-2 text-xl font-semibold"><CalendarClock size={22} />Automation</h1>
      <p className="mt-2 text-sm text-muted-foreground">Schedules, goals, and recurring workflows for {projectId ? snapshot?.projects.find(project => project.id === projectId)?.name ?? 'the selected workspace' : 'all workspaces'}. This list updates automatically; manage them through Mastermind.</p>
    </header>

    <section aria-labelledby="automation-schedules" className="mb-8">
      <h2 id="automation-schedules" className="mb-3 font-semibold">Scheduled tasks <span className="text-muted-foreground">({schedules.length})</span></h2>
      {tasksError && <p role="alert" className="mb-3 text-sm text-destructive">Could not load scheduled tasks: {tasksError}</p>}
      {tasksLoading && <p role="status" className="text-sm text-muted-foreground">Loading scheduled tasks…</p>}
      {!tasksLoading && !tasksError && !schedules.length && <p className="text-sm text-muted-foreground">No scheduled tasks yet. Ask Mastermind to set up a recurring workflow.</p>}
      {schedules.length > 0 && <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Scheduled tasks for the selected workspace filter</caption>
          <thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th scope="col" className="p-3">Schedule</th><th scope="col" className="p-3">Status</th><th scope="col" className="p-3">Timing</th></tr></thead>
          <tbody>{schedules.map(task => {
            const completed = task.recurrence_mode === 'reuse' && task.status === TaskStatus.Completed
            const stopped = task.recurrence_paused || completed
            return <tr key={task.id} className="border-t border-border align-top">
              <th scope="row" className="p-3 font-normal">
                <div className="flex flex-wrap items-center gap-2"><p className="break-words font-medium">{task.title}</p><WorkspaceBadge projectId={workspaceForTask(task.id)} /></div>
                <p className="mt-1 break-words text-xs text-muted-foreground">{task.repos.length ? task.repos.join(', ') : 'No repository linked'}</p>
                {!task.server_managed && <p className="mt-1 text-xs text-muted-foreground">{task.recurrence_mode === 'reuse' ? 'Reuse one task' : 'Create a task each time'} · {task.auto_start_agent ? 'Auto-start enabled' : 'Manual start'}</p>}
              </th>
              <td className="p-3">{task.server_managed ? 'Managed by source' : completed ? 'Completed' : task.recurrence_paused ? 'Paused' : task.next_occurrence_at ? 'Scheduled' : 'No next run'}</td>
              <td className="p-3 text-xs text-muted-foreground">
                <p>Next scheduled: {task.server_managed || stopped ? '—' : dateLabel(task.next_occurrence_at)}</p>
                <p className="mt-1">Last triggered: {dateLabel(task.last_occurrence_at)}</p>
              </td>
            </tr>
          })}</tbody>
        </table>
      </div>}
    </section>

    <section aria-labelledby="automation-goals">
      <h2 id="automation-goals" className="mb-3 font-semibold">Project goals and routines <span className="text-muted-foreground">({work.length})</span></h2>
      {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}{snapshot ? ' Showing the last loaded list.' : ''}</p>}
      {!snapshot && !error && <p role="status" className="text-sm text-muted-foreground">Loading project goals and routines…</p>}
      {snapshot && !error && !work.length && <p className="text-sm text-muted-foreground">No project goals or routines yet. Describe one to Mastermind in a project conversation.</p>}
      {work.length > 0 && <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Mastermind project goals and routines</caption>
          <thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th scope="col" className="p-3">Goal or routine</th><th scope="col" className="p-3">Status</th><th scope="col" className="p-3">Progress and next step</th></tr></thead>
          <tbody>{work.map(record => <tr key={record.id} className="border-t border-border align-top">
            <th scope="row" className="p-3 font-normal">
              <div className="flex flex-wrap items-center gap-2"><p className="break-words font-medium">{record.agreement.title}</p><WorkspaceBadge projectId={record.projectId} /></div>
              <p className="mt-1 text-xs text-muted-foreground">{record.agreement.kind === 'goal' ? 'Goal' : 'Recurring workflow'}</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{record.agreement.objective}</p>
            </th>
            <td className="p-3">{stateLabels[record.state]}</td>
            <td className="p-3 text-xs text-muted-foreground">
              <p>Steps used: {record.steps} / {record.agreement.maxSteps}</p>
              {record.agreement.kind === 'routine' && <>
                <p className="mt-1">Next scheduled: {record.state === 'active' ? dateLabel(record.nextAt) : '—'}</p>
                <p className="mt-1">Last successful check: {dateLabel(record.lastCollectedAt)}</p>
              </>}
              {record.next && !['completed', 'cancelled'].includes(record.state) && <p className="mt-1 whitespace-pre-wrap break-words">Saved next step: {record.next.instruction}</p>}
            </td>
          </tr>)}</tbody>
        </table>
      </div>}
    </section>
    <p className="mt-6 text-xs text-muted-foreground">Times use this computer’s timezone. Fully quitting 20x stops local agents and monitoring.</p>
  </div>
}
