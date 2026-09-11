import { createHash } from 'node:crypto'
import type { Tool } from '@modelcontextprotocol/server'
import type { DatabaseManager, TaskRecord } from './database'
import type { AgentManager } from './agent-manager'
import type { ResponsibilityManager } from './responsibility-manager'
import type { SyncManager } from './sync-manager'
import { PluginActionId, TaskStatus } from '../shared/constants'
import { isMastermindTask } from '../shared/responsibilities'
import type { RecurrenceScheduler } from './recurrence-scheduler'
import { isWorkfloLinkedTask } from './workflo-task-sync'

export const taskControlTools: Tool[] = [
  {
    name: 'inspect_responsibilities', description: 'Find saved project Task, Goal and Routine agreements by title or exact responsibility ID. Includes inactive proposals shown in Automation and Mastermind Work, which are distinct from ordinary 20x tasks. Use before deleting a proposal; clarify ambiguous matches.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' }, responsibility_id: { type: 'string' } } }
  },
  {
    name: 'delete_responsibility_proposal', description: 'Ask the engineer to confirm deleting an exact inactive Task, Goal or Routine proposal from Mastermind Work and Automation. Retains any source-trial tasks, results, files and project memory. Refuses active or changed agreements and unresolved source trials; does not cancel running work. Use manage_task for ordinary task or recurring-task deletion. Mastermind administration: do not delegate or use computer control. No model approval flag; report only the returned outcome.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { responsibility_id: { type: 'string' } }, required: ['responsibility_id'] }
  },
  {
    name: 'inspect_tasks', description: 'Find 20x tasks, including recurring schedule templates, by title or exact ID before managing them. Returns task metadata, source, responsibility ownership and schedule state. Clarify ambiguous matches with the engineer. To pause a schedule choose its recurring template, not an individual run.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' }, task_id: { type: 'string' }, runs: { type: 'boolean', description: 'With task_id, list recent checks for that schedule.' }, run_id: { type: 'string', description: 'Read this run including its transcript and archived artifact paths.' }, before: { type: 'string', description: 'List runs due before this ISO timestamp.' } } }
  },
  {
    name: 'manage_task', description: 'Ask the engineer to confirm completing, deleting, or pausing/resuming the schedule of an exact 20x task. For a requested batch deletion, use task_ids in ONE call for one approval of the full list. Close means complete, not close its panel. pause_schedule and resume_schedule target a local recurring template: pause stops future instances, preserves existing runs and settings; resume starts at the next future occurrence without replaying the paused period. reuse_schedule/separate_schedule change execution mode only on a paused schedule with no unresolved check. recover_schedule releases an inspected interrupted check, retaining its history and leaving scheduling paused. Use inspect_tasks with runs or run_id to read history. This does not control project Routine agreements or global auto-run. This is task administration performed by Mastermind itself, not delegated project work or computer use. Completion follows the existing task-source confirmation flow. Deletion removes the local task and its subtasks, stops their agents and cancels their responsibilities. Never treat a declined, pending or failed action as completed. There is no model-supplied approval flag.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      task_id: { type: 'string', description: 'Single-task action. Omit when supplying task_ids for a batch deletion.' },
      task_ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' }, description: 'Delete only: exact task IDs from inspect_tasks. Use ONE call for a requested batch so the engineer approves the full list once; do not loop over individual deletions. Includes dependent tasks. Do not also pass task_id.' },
      action: { type: 'string', enum: ['complete', 'close', 'delete', 'pause_schedule', 'resume_schedule', 'reuse_schedule', 'separate_schedule', 'recover_schedule'] }
    }, required: ['action'] }
  }
]

type Confirmation = { title: string; detail: string; confirmLabel: string; signal: AbortSignal }
type Runtime = Pick<AgentManager, 'withStoppedTasks'>
const fingerprint = (tasks: TaskRecord[]): string => createHash('sha256').update(JSON.stringify(tasks.map(task => {
  // These fields are changed by stopping agents, without changing the human's decision.
  return Object.fromEntries(Object.entries(task).filter(([key]) => !['updated_at', 'auto_start_agent', 'auto_complete_without_review', 'heartbeat_enabled'].includes(key)))
}))).digest('hex')

/** Human task administration shared by global and project Mastermind. */
export class TaskControl {
  // ponytail: one human confirmation at a time; per-tree locks if parallel administration is needed.
  private pending?: Promise<unknown>
  private readonly shutdown = new AbortController()

  constructor(
    private readonly db: DatabaseManager,
    private readonly agents: Runtime,
    private readonly sync: Pick<SyncManager, 'completeTask'>,
    private readonly responsibilities: ResponsibilityManager,
    private readonly confirm: (request: Confirmation) => Promise<boolean>,
    private readonly notify: (channel: string, data: unknown) => void,
    private readonly recurrence?: Pick<RecurrenceScheduler, 'setPaused' | 'setMode' | 'history' | 'recover' | 'releaseForControl'>
  ) {}

  private task(id: unknown, projectId?: string): TaskRecord {
    if (typeof id !== 'string' || !id || isMastermindTask(id)) throw new Error('Choose an existing task, not a Mastermind conversation.')
    const task = this.db.getTask(id)
    if (!task) throw new Error('Task not found. Inspect current tasks before trying again.')
    const project = this.responsibilities.projectForTask(id)
    if (projectId && project && project.id !== projectId) throw new Error('This task belongs to another project. Switch to that project or All tasks in Mastermind.')
    return task
  }

  inspect(args: Record<string, unknown>, projectId?: string): unknown {
    if (args.runs || args.run_id) {
      const task = this.task(args.task_id, projectId)
      return this.recurrence?.history(task.id, typeof args.run_id === 'string' ? args.run_id : undefined, typeof args.before === 'string' ? args.before : undefined) ?? []
    }
    const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
    const tasks = args.task_id ? [this.task(args.task_id, projectId)] : this.db.getTasks()
    return tasks.filter(t => {
      const owner = this.responsibilities.projectForTask(t.id)
      return !isMastermindTask(t.id) && (!projectId || !owner || owner.id === projectId) && (!query || t.title.toLowerCase().includes(query) || t.id === query)
    }).slice(0, 100).map(t => ({ id: t.id, title: t.title, status: t.status, parentTaskId: t.parent_task_id,
      source: t.source_id ? this.db.getTaskSource(t.source_id)?.name ?? t.source : 'Local task',
      project: this.responsibilities.projectForTask(t.id)?.name ?? null, updatedAt: t.updated_at,
      recurrenceParentId: t.recurrence_parent_id,
      schedule: t.is_recurring && !t.recurrence_parent_id ? { pattern: t.recurrence_pattern, mode: t.recurrence_mode || 'separate', paused: !!t.recurrence_paused, nextAt: t.next_occurrence_at } : null }))
  }

  private tree(task: TaskRecord): TaskRecord[] {
    const tasks = [task]
    const all = this.db.getTasks()
    for (const parent of tasks) for (const child of all.filter(t => t.parent_task_id === parent.id || t.recurrence_parent_id === parent.id)) {
      if (!tasks.some(t => t.id === child.id)) tasks.push(child)
    }
    return tasks
  }

  inspectResponsibilities(args: Record<string, unknown>, projectId?: string): unknown {
    const snapshot = this.responsibilities.snapshot(projectId)
    const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
    return snapshot.responsibilities.filter(r => (!args.responsibility_id || r.id === args.responsibility_id) && (!query || r.agreement.title.toLowerCase().includes(query) || r.id === query))
      .map(r => ({ id: r.id, title: r.agreement.title, kind: r.agreement.kind, state: r.state, revision: r.revision, steps: r.steps, project: snapshot.projects.find(p => p.id === r.projectId)?.name ?? r.projectId }))
  }

  async deleteProposal(args: Record<string, unknown>, projectId?: string): Promise<unknown> {
    return this.runExclusive(async () => {
      const proposal = this.responsibilities.proposalForDeletion(args.responsibility_id, projectId)
      const project = this.responsibilities.snapshot(proposal.projectId).projects.find(p => p.id === proposal.projectId)
      const approved = await this.confirm({ title: `Delete ${proposal.agreement.kind} proposal “${proposal.agreement.title}”?`, confirmLabel: 'Delete proposal', signal: this.shutdown.signal,
        detail: `Project: ${project?.name ?? proposal.projectId}\nProposal: ${proposal.id}\nRevision: ${proposal.revision}\nObjective: ${proposal.agreement.objective}\n\nRemove this inactive proposal from Work and Automation. Any source-trial tasks, saved results, files, and project memory remain. Running or changed proposals cannot be deleted with this confirmation.` })
      if (!approved || this.shutdown.signal.aborted) return { success: false, cancelled: true, responsibilityId: proposal.id }
      this.responsibilities.deleteProposal(proposal.id, proposal, projectId)
      return { success: true, deleted: true, responsibilityId: proposal.id, title: proposal.agreement.title }
    })
  }

  private async runExclusive(action: () => Promise<unknown>): Promise<unknown> {
    this.shutdown.signal.throwIfAborted()
    if (this.pending) throw new Error('A task action is already waiting or running. Do not submit another action yet.')
    const job = action()
    this.pending = job
    try { return await job } finally { this.pending = undefined }
  }

  async run(args: Record<string, unknown>, projectId?: string): Promise<unknown> {
    this.shutdown.signal.throwIfAborted()
    const action = args.action === 'close' ? 'complete' : args.action
    if (action !== 'complete' && action !== 'delete' && action !== 'pause_schedule' && action !== 'resume_schedule' && action !== 'reuse_schedule' && action !== 'separate_schedule' && action !== 'recover_schedule') throw new Error('Choose complete, close, delete, pause_schedule, or resume_schedule.')
    if (args.task_ids !== undefined) {
      if (args.task_id !== undefined || action !== 'delete' || !Array.isArray(args.task_ids) || !args.task_ids.length || args.task_ids.length > 100) throw new Error('For bulk deletion, supply 1–100 exact task_ids and action delete, without task_id.')
      const tasks = [...new Set(args.task_ids)].map(id => this.task(id, projectId))
      return this.runExclusive(() => this.perform(tasks, 'delete', projectId))
    }
    const task = this.task(args.task_id, projectId)
    return this.runExclusive(() => action === 'reuse_schedule' || action === 'separate_schedule' || action === 'recover_schedule'
      ? this.configureSchedule(task, action, projectId)
      : action === 'pause_schedule' || action === 'resume_schedule'
      ? this.changeSchedule(task, action === 'pause_schedule', projectId)
      : this.perform([task], action, projectId))
  }

  private async configureSchedule(task: TaskRecord, action: string, projectId?: string): Promise<unknown> {
    if (!this.recurrence) throw new Error('Schedule controls are unavailable.')
    if (!task.is_recurring || task.recurrence_parent_id || task.server_managed || isWorkfloLinkedTask(this.db, task) || !task.recurrence_paused) throw new Error('Choose a paused local schedule.')
    const snapshot = JSON.stringify(task)
    const approved = await this.confirm({ title: `Update schedule for “${task.title}”?`, confirmLabel: action === 'recover_schedule' ? 'Release interrupted check' : 'Change execution mode', signal: this.shutdown.signal,
      detail: `Task: ${task.id}\n${action === 'recover_schedule' ? 'Confirm you inspected the interrupted check. Stop any remaining runtime and retain the partial history. Scheduling stays paused.' : `Use ${action === 'reuse_schedule' ? 'one persistent task with individual run history' : 'a separate task for each occurrence'}. Existing tasks and results remain. Task auto-completion is disabled; scheduling stays paused.`}` })
    if (!approved || this.shutdown.signal.aborted) return { success: false, cancelled: true, taskId: task.id }
    if (JSON.stringify(this.task(task.id, projectId)) !== snapshot) throw new Error('The task changed. Inspect it and confirm again.')
    if (action === 'recover_schedule') await this.recurrence.recover(task.id)
    else this.recurrence.setMode(task.id, action === 'reuse_schedule' ? 'reuse' : 'separate')
    const updated = this.db.getTask(task.id)
    this.notify('task:updated', { taskId: task.id, updates: updated })
    return { success: true, taskId: task.id, mode: updated?.recurrence_mode, schedulePaused: updated?.recurrence_paused }
  }

  private async changeSchedule(task: TaskRecord, paused: boolean, projectId?: string): Promise<unknown> {
    if (!this.recurrence) throw new Error('Schedule controls are unavailable.')
    if (!task.is_recurring || task.recurrence_parent_id || !task.recurrence_pattern) throw new Error('Choose a recurring task template, not an individual run. Use inspect_tasks to find its template.')
    if (task.server_managed || isWorkfloLinkedTask(this.db, task)) throw new Error('This schedule is managed by Workflo. Change it at its source.')
    const snapshot = JSON.stringify(task)
    if (!!task.recurrence_paused !== paused) {
      const approved = await this.confirm({ title: `${paused ? 'Pause' : 'Resume'} schedule for “${task.title}”?`, confirmLabel: paused ? 'Pause schedule' : 'Resume schedule', signal: this.shutdown.signal,
        detail: `Task: ${task.id}\nSchedule: ${JSON.stringify(task.recurrence_pattern)}\n` + (paused
          ? 'Stop creating new recurring instances. Existing runs, agents, history and automation settings remain unchanged.'
          : 'Create instances from the next future scheduled time. Do not replay the paused period. Existing auto-start and auto-complete settings apply.') })
      if (!approved || this.shutdown.signal.aborted) return { success: false, cancelled: true, taskId: task.id }
      if (JSON.stringify(this.task(task.id, projectId)) !== snapshot) throw new Error('The task or schedule changed. Inspect it and confirm again.')
    }
    const updated = this.recurrence.setPaused(task.id, paused)
    this.notify('task:updated', { taskId: task.id, updates: updated })
    return { success: true, taskId: task.id, schedulePaused: !!updated.recurrence_paused, nextOccurrenceAt: updated.next_occurrence_at, existingRunsUnchanged: true }
  }

  private async perform(tasks: TaskRecord[], action: 'complete' | 'delete', projectId?: string): Promise<unknown> {
    const task = tasks[0]
    const target = tasks.length === 1 ? { taskId: task.id } : { taskIds: tasks.map(t => t.id) }
    if (action === 'complete' && task.status === TaskStatus.Completed) return { success: true, taskId: task.id, status: 'completed', alreadyCompleted: true }
    const collect = () => [...new Map(tasks.flatMap(t => action === 'delete' ? this.tree(this.task(t.id, projectId)) : [this.task(t.id, projectId)]).map(t => [t.id, t])).values()]
    const affected = collect()
    for (const item of affected) {
      this.task(item.id, projectId)
      if (this.db.getSetting(`workflo-completion:${item.id}`) || this.db.getSetting(`workflo-upload:${item.id}`)) throw new Error('This task has a pending Workflo command. Sync and resolve that command before completing or deleting it.')
    }
    const owners = [...new Set(affected.flatMap(t => {
      const step = this.responsibilities.stepForTask(t.id)
      return step ? [step.responsibilityId] : []
    }))]
    const agreements = this.responsibilities.snapshot().responsibilities.filter(r => owners.includes(r.id))
    let snapshot = fingerprint(affected)
    const sources = (items: TaskRecord[]) => JSON.stringify(items.map(t => t.source_id ? this.db.getTaskSource(t.source_id) : null))
    const sourceSnapshot = sources(affected)
    const account = this.db.getSetting('workflo-sync-scope')
    const unchanged = () => {
      const current = collect()
      if (fingerprint(current) !== snapshot || sources(current) !== sourceSnapshot ||
        this.db.getSetting('workflo-sync-scope') !== account || affected.some(t => this.db.getSetting(`workflo-completion:${t.id}`) || this.db.getSetting(`workflo-upload:${t.id}`))) throw new Error('The task or source changed. Nothing was deleted or completed; inspect it and confirm again. Agents and responsibilities may already have been stopped.')
    }
    const label = action === 'delete' ? 'Delete' : 'Complete'
    const source = task.source_id ? this.db.getTaskSource(task.source_id)?.name ?? task.source : 'Local task'
    const approved = await this.confirm({ title: tasks.length > 1 ? `Delete ${affected.length} tasks?` : `${label} “${task.title}”?`, confirmLabel: tasks.length > 1 ? `Delete ${affected.length} tasks` : `${label} task`, signal: this.shutdown.signal,
      detail: (action === 'delete'
        ? `Delete these ${affected.length} local tasks, including subtasks and recurring instances:\n${affected.map(t => `• ${t.title} [${t.id}]`).join('\n')}\n\nTheir attachments and transcripts are deleted. Working checkouts are retained. Linked sources are not deleted and may restore tasks on sync.\n`
        : `Task: ${task.id}\nSource: ${source}\nRun source action: ${task.output_fields.find(f => f.id === 'action')?.value || PluginActionId.Complete}. Submitted output fields: ${JSON.stringify(task.output_fields)}. ${task.source_id ? 'Completion requires confirmation from this source.' : 'This local task must first be sent to Workflo; a Workflo connection, eligible agent and skills are required. Completion requires Workflo confirmation.'}\n`) +
        (agreements.length ? `Stop and cancel these responsibilities so they cannot schedule replacement work: ${agreements.map(r => r.agreement.title).join(', ')}. Their saved agreements and reports remain.\n` : '') +
        (affected.some(t => t.is_recurring && !t.recurrence_parent_id) ? 'Pause future checks for the affected schedules, including if completion cannot be confirmed.\n' : '') +
        'Active agents for the affected tasks will be stopped before changing the tasks.' })
    if (!approved || this.shutdown.signal.aborted) return { success: false, cancelled: true, ...target }
    unchanged()
    const latest = this.responsibilities.snapshot().responsibilities.filter(r => owners.includes(r.id))
    if (JSON.stringify(latest) !== JSON.stringify(agreements)) throw new Error('The responsibility changed while confirmation was open. Review it again.')
    return this.agents.withStoppedTasks(affected.map(t => t.id), async () => {
      this.shutdown.signal.throwIfAborted()
      unchanged()
      for (const item of affected) if (item.is_recurring && !item.recurrence_parent_id) await this.recurrence?.releaseForControl(item.id)
      this.shutdown.signal.throwIfAborted()
      unchanged()
      if (action === 'delete') {
        // Delete children explicitly so their owned attachments and transcripts are cleaned too.
        try {
          for (const item of [...affected].reverse()) {
            this.db.deleteTask(item.id)
            this.notify('task:deleted', { taskId: item.id })
          }
        } catch (error) {
          this.notify('tasks:refresh', {})
          return { success: false, ...target, error: (error as Error).message,
            deletedTaskIds: affected.filter(t => !this.db.getTask(t.id)).map(t => t.id),
            remainingTaskIds: affected.filter(t => this.db.getTask(t.id)).map(t => t.id) }
        }
        this.notify('tasks:refresh', {})
        return { success: true, ...target, deletedTaskIds: affected.map(t => t.id) }
      }
      const result = await this.sync.completeTask(task.id)
      this.notify('tasks:refresh', {})
      return { ...result, taskId: task.id, status: this.db.getTask(task.id)?.status }
    }, async () => {
      unchanged()
      const expected = affected.map(item => {
        if (!item.is_recurring || item.recurrence_parent_id || item.server_managed || isWorkfloLinkedTask(this.db, item) || !this.recurrence) return item
        const paused = this.recurrence.setPaused(item.id, true)
        return { ...item, recurrence_paused: paused.recurrence_paused, next_occurrence_at: paused.next_occurrence_at }
      })
      snapshot = fingerprint(expected)
      for (const owner of latest) await this.responsibilities.act(owner.id, owner.revision, 'cancel')
    })
  }

  async stop(): Promise<void> {
    this.shutdown.abort()
    await Promise.allSettled(this.pending ? [this.pending] : [])
  }
}
