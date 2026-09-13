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
import type { TaskGroup, TaskGroupAction, TaskGroupResult } from '../shared/task-groups'

export const taskControlTools: Tool[] = [
  {
    name: 'inspect_groups', description: 'List Groups and their task membership in Tasks and Canvas. Groups organize work without changing sessions, permissions, dependencies or context. Inspect before moving or deleting a Group.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  },
  {
    name: 'manage_group', description: 'Create or rename a Group, assign existing tasks (null group_id removes membership), or assign a saved execution and its future stages to a Group. Use task_ids in one call for batch membership changes. Groups live above tasks in Tasks and Canvas. delete preserves tasks and leaves future stages Ungrouped; delete_with_tasks asks for ONE human confirmation to stop affected work and delete the Group with its tasks and dependent subtasks/instances. Never claim cancellation or partial deletion succeeded. Grouping does not authorize execution.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      action: { type: 'string', enum: ['create', 'update', 'assign', 'delete', 'delete_with_tasks', 'assign_execution'] },
      group_id: { type: ['string', 'null'] }, name: { type: 'string' }, description: { type: 'string' }, project_id: { type: 'string' },
      task_ids: { type: 'array', maxItems: 1000, items: { type: 'string' } }, responsibility_id: { type: 'string' }
    }, required: ['action'] }
  },
  {
    name: 'inspect_responsibilities', description: 'Find saved project Task, Goal and Routine agreements by title or exact responsibility ID. Includes proposed and cancelled responsibilities shown in Automation and Mastermind Work, which are distinct from ordinary 20x tasks. Use before deletion; clarify ambiguous matches.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' }, responsibility_id: { type: 'string' } } }
  },
  {
    name: 'delete_responsibility_proposal', description: 'Ask the engineer to confirm deleting an exact proposed or cancelled Task, Goal or Routine responsibility from Mastermind Work and Automation. Retains any source-trial tasks, results, files and project memory. Refuses active or changed agreements and unresolved source trials or workers; does not cancel running work. Use manage_task for ordinary task or recurring-task deletion. Mastermind administration: do not delegate or use computer control. No model approval flag; report only the returned outcome.',
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
  ) {
    db.groups.onChanged = () => notify('task-groups:changed', {})
  }

  inspectGroups(projectId?: string): ReturnType<DatabaseManager['groups']['snapshot']> {
    const snapshot = this.db.groups.snapshot()
    if (!projectId) return snapshot
    const groups = snapshot.groups.filter(g => g.projectId === projectId)
    const ids = new Set(groups.map(g => g.id))
    return { groups, membership: Object.fromEntries(Object.entries(snapshot.membership).filter(([, id]) => ids.has(id))),
      executions: Object.fromEntries(Object.entries(snapshot.executions).filter(([, id]) => id && ids.has(id))) }
  }

  async manageGroup(input: Record<string, unknown> | TaskGroupAction, projectId?: string): Promise<TaskGroupResult> {
    const args = input as TaskGroupAction
    return this.runExclusive(async () => {
      if (projectId && args.project_id && args.project_id !== projectId) throw new Error('Choose a Group in the current project.')
      let scope = projectId ?? args.project_id
      if (scope && !this.responsibilities.snapshot().projects.some(p => p.id === scope)) throw new Error('Project not found.')
      const ids = args.task_ids === undefined ? [] : args.task_ids
      if (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => typeof id !== 'string')) throw new Error('Supply at most 1000 exact task IDs.')
      const tasks = [...new Set(ids)].map(id => this.task(id, scope))
      const membership = this.db.groups.snapshot().membership
      for (const task of tasks) if (scope && membership[task.id]) this.db.groups.get(membership[task.id], scope)
      if (args.action === 'create') {
        const owners = [...new Set(tasks.map(t => this.responsibilities.projectForTask(t.id)?.id).filter((id): id is string => !!id))]
        if (owners.length > 1 || (scope && owners.some(id => id !== scope))) throw new Error('A Group can contain work from one project. Select tasks from the same project.')
        scope ??= owners[0]
        let group!: TaskGroup
        this.db.db.transaction(() => {
          group = this.db.groups.create(args.name, args.description ?? '', scope ?? null)
          this.db.groups.assign(tasks.map(t => t.id), group.id)
        })()
        return { success: true, groupId: group.id }
      }
      if (args.group_id === undefined) throw new Error('Choose an exact Group, or null to remove membership.')
      const group = args.group_id === null ? null : this.db.groups.get(args.group_id, scope)
      // Global administration may organize local tasks, but cannot mix project-owned executions.
      if (group) for (const task of tasks) {
        const owner = this.responsibilities.projectForTask(task.id)
        if (owner && owner.id !== group.projectId) throw new Error('The task and Group must belong to the same project.')
      }
      if (args.action === 'assign') {
        if (!tasks.length) throw new Error('Select tasks to move or remove.')
        this.db.groups.assign(tasks.map(t => t.id), group?.id ?? null)
      } else if (args.action === 'assign_execution') {
        const snapshot = this.responsibilities.snapshot(scope)
        const execution = snapshot.responsibilities.find(r => r.id === args.responsibility_id)
        if (!execution || (group && group.projectId !== execution.projectId)) throw new Error('Choose a saved execution in the same project as the Group.')
        this.db.groups.assignExecution(execution.id, group?.id ?? null)
        // Past tasks retain explicit human membership choices; task_ids moves them when requested.
        if (tasks.length) this.db.groups.assign(tasks.map(t => t.id), group?.id ?? null)
      } else {
        if (!group) throw new Error('Choose an existing Group.')
        if (args.action === 'update') this.db.groups.update(group.id, args.name, args.description)
        else if (args.action === 'delete_with_tasks') {
          const members = Object.entries(membership).filter(([, id]) => id === group.id).map(([id]) => this.task(id, scope))
          return await this.perform(members, 'delete', scope, group) as TaskGroupResult
        } else if (args.action === 'delete') {
          const receipt = this.groupFingerprint(group.id)
          const approved = await this.confirm({ title: `Delete Group “${group.name}”?`, confirmLabel: 'Delete Group only', signal: this.shutdown.signal,
            detail: 'Keep all tasks, agents, schedules and saved results. Tasks in this Group become Ungrouped. Future stages of its executions remain Ungrouped; the Group will not be recreated.' })
          if (!approved || this.shutdown.signal.aborted) return { success: false, cancelled: true }
          if (receipt !== this.groupFingerprint(group.id)) throw new Error('The Group changed. Review it again.')
          this.db.groups.remove(group.id)
        } else throw new Error('Choose a valid Group action.')
      }
      return { success: true, ...(group ? { groupId: group.id } : {}) }
    }) as Promise<TaskGroupResult>
  }

  private groupFingerprint(id: string): string {
    const snapshot = this.db.groups.snapshot()
    return JSON.stringify({ group: this.db.groups.get(id), tasks: Object.entries(snapshot.membership).filter(([, group]) => group === id), executions: Object.entries(snapshot.executions).filter(([, group]) => group === id) })
  }

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
    const membership = this.db.groups.snapshot().membership
    const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
    const tasks = args.task_id ? [this.task(args.task_id, projectId)] : this.db.getTasks()
    return tasks.filter(t => {
      const owner = this.responsibilities.projectForTask(t.id)
      return !isMastermindTask(t.id) && (!projectId || !owner || owner.id === projectId) && (!query || t.title.toLowerCase().includes(query) || t.id === query)
    }).slice(0, 100).map(t => ({ id: t.id, title: t.title, status: t.status, parentTaskId: t.parent_task_id,
      source: t.source_id ? this.db.getTaskSource(t.source_id)?.name ?? t.source : 'Local task',
      project: this.responsibilities.projectForTask(t.id)?.name ?? null, groupId: membership[t.id] ?? null, updatedAt: t.updated_at,
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
      const approved = await this.confirm({ title: `Delete ${proposal.agreement.kind} “${proposal.agreement.title}”?`, confirmLabel: 'Delete responsibility', signal: this.shutdown.signal,
        detail: `Project: ${project?.name ?? proposal.projectId}\nResponsibility: ${proposal.id}\nRevision: ${proposal.revision}\nObjective: ${proposal.agreement.objective}\n\nRemove this proposed or cancelled responsibility from Work and Automation. Any source-trial tasks, saved results, files, and project memory remain. Running, unreleased, or changed responsibilities cannot be deleted with this confirmation.` })
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

  private async perform(tasks: TaskRecord[], action: 'complete' | 'delete', projectId?: string, group?: TaskGroup): Promise<unknown> {
    const task = tasks[0]
    const target = tasks.length === 1 ? { taskId: task.id } : { taskIds: tasks.map(t => t.id) }
    if (action === 'complete' && task.status === TaskStatus.Completed) return { success: true, taskId: task.id, status: 'completed', alreadyCompleted: true }
    const collect = () => [...new Map(tasks.flatMap(t => action === 'delete' ? this.tree(this.task(t.id, projectId)) : [this.task(t.id, projectId)]).map(t => [t.id, t])).values()]
    const affected = collect()
    for (const item of affected) {
      this.task(item.id, projectId)
      if (this.db.getSetting(`workflo-completion:${item.id}`) || this.db.getSetting(`workflo-upload:${item.id}`)) throw new Error('This task has a pending Workflo command. Sync and resolve that command before completing or deleting it.')
    }
    const owners = [...new Set([...affected.flatMap(t => {
      const step = this.responsibilities.stepForTask(t.id)
      return step ? [step.responsibilityId] : []
    }), ...Object.entries(this.db.groups.snapshot().executions).filter(([, id]) => group && id === group.id).map(([id]) => id)])]
    const ownerSnapshot = this.responsibilities.snapshot()
    const agreements = ownerSnapshot.responsibilities.filter(r => owners.includes(r.id))
    const retainedTasks = group ? (ownerSnapshot.steps ?? []).filter(s => owners.includes(s.responsibilityId) && !affected.some(t => t.id === s.taskId)).flatMap(s => { const task = this.db.getTask(s.taskId); return task ? [task] : [] }) : []
    let snapshot = fingerprint(affected)
    const sources = (items: TaskRecord[]) => JSON.stringify(items.map(t => t.source_id ? this.db.getTaskSource(t.source_id) : null))
    const sourceSnapshot = sources(affected)
    const account = this.db.getSetting('workflo-sync-scope')
    const groupReceipt = group ? this.groupFingerprint(group.id) : undefined
    const memberState = () => {
      const membership = this.db.groups.snapshot().membership
      return JSON.stringify(affected.map(t => [t.id, membership[t.id] ?? null]))
    }
    const memberReceipt = group ? memberState() : undefined
    const unchanged = () => {
      if (group && (groupReceipt !== this.groupFingerprint(group.id) || memberReceipt !== memberState())) throw new Error('The Group membership changed. Review the deletion again.')
      const current = collect()
      if (fingerprint(current) !== snapshot || sources(current) !== sourceSnapshot ||
        this.db.getSetting('workflo-sync-scope') !== account || affected.some(t => this.db.getSetting(`workflo-completion:${t.id}`) || this.db.getSetting(`workflo-upload:${t.id}`))) throw new Error('The task or source changed. Nothing was deleted or completed; inspect it and confirm again. Agents and responsibilities may already have been stopped.')
    }
    const label = action === 'delete' ? 'Delete' : 'Complete'
    const source = task?.source_id ? this.db.getTaskSource(task.source_id)?.name ?? task.source : 'Local task'
    const approved = await this.confirm({ title: group ? `Delete “${group.name}” and all ${affected.length} tasks?` : tasks.length > 1 ? `Delete ${affected.length} tasks?` : `${label} “${task.title}”?`, confirmLabel: group ? 'Delete Group and tasks' : tasks.length > 1 ? `Delete ${affected.length} tasks` : `${label} task`, signal: this.shutdown.signal,
      detail: (group ? `Delete Group: ${group.name} [${group.id}].\n\n` : '') + (action === 'delete'
        ? `Delete these ${affected.length} local tasks, including subtasks and recurring instances:\n${affected.map(t => `• ${t.title} [${t.id}]`).join('\n')}\n\nTheir attachments and transcripts are deleted. Working checkouts are retained. Linked sources are not deleted and may restore tasks on sync.\n`
        : `Task: ${task.id}\nSource: ${source}\nRun source action: ${task.output_fields.find(f => f.id === 'action')?.value || PluginActionId.Complete}. Submitted output fields: ${JSON.stringify(task.output_fields)}. ${task.source_id ? 'Completion requires confirmation from this source.' : 'A Workflo connection is required to save this task under your account and confirm completion. Local agents, skills, and schedules are not transferred. Saved history and outputs remain.'}\n`) +
        (agreements.length ? `Stop and cancel these responsibilities so they cannot schedule replacement work: ${agreements.map(r => r.agreement.title).join(', ')}. Their saved agreements and reports remain.\n` : '') +
        (retainedTasks.length ? `Tasks from those executions outside this deletion list will be retained; their execution will also be cancelled: ${retainedTasks.map(t => `${t.title} [${t.id}]`).join(', ')}.\n` : '') +
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
          if (group) this.db.groups.remove(group.id)
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
      for (const owner of latest) if (!group || !['completed', 'cancelled'].includes(owner.state)) await this.responsibilities.act(owner.id, owner.revision, 'cancel')
    })
  }

  async stop(): Promise<void> {
    this.shutdown.abort()
    await Promise.allSettled(this.pending ? [this.pending] : [])
  }
}
