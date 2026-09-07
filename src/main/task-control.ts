import { createHash } from 'node:crypto'
import type { Tool } from '@modelcontextprotocol/server'
import type { DatabaseManager, TaskRecord } from './database'
import type { AgentManager } from './agent-manager'
import type { ResponsibilityManager } from './responsibility-manager'
import type { SyncManager } from './sync-manager'
import { PluginActionId, TaskStatus } from '../shared/constants'
import { isMastermindTask } from '../shared/responsibilities'

export const taskControlTools: Tool[] = [
  {
    name: 'inspect_tasks', description: 'Find 20x tasks by title or exact ID before managing them. Returns task metadata, source and responsibility ownership. Clarify ambiguous matches with the engineer.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' }, task_id: { type: 'string' } } }
  },
  {
    name: 'manage_task', description: 'Ask the engineer to confirm completing or deleting an exact 20x task. Close means complete, not close its panel. This is task administration performed by Mastermind itself, not delegated project work. Completion follows the existing task-source confirmation flow. Deletion removes the local task and its subtasks, stops their agents and cancels their responsibilities. Never treat a declined, pending or failed action as completed. There is no model-supplied approval flag.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { task_id: { type: 'string' }, action: { type: 'string', enum: ['complete', 'close', 'delete'] } }, required: ['task_id', 'action'] }
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
    private readonly notify: (channel: string, data: unknown) => void
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
    const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
    const tasks = args.task_id ? [this.task(args.task_id, projectId)] : this.db.getTasks()
    return tasks.filter(t => {
      const owner = this.responsibilities.projectForTask(t.id)
      return !isMastermindTask(t.id) && (!projectId || !owner || owner.id === projectId) && (!query || t.title.toLowerCase().includes(query) || t.id === query)
    }).slice(0, 100).map(t => ({ id: t.id, title: t.title, status: t.status, parentTaskId: t.parent_task_id,
      source: t.source_id ? this.db.getTaskSource(t.source_id)?.name ?? t.source : 'Local task',
      project: this.responsibilities.projectForTask(t.id)?.name ?? null, updatedAt: t.updated_at }))
  }

  private tree(task: TaskRecord): TaskRecord[] {
    const tasks = [task]
    const all = this.db.getTasks()
    for (const parent of tasks) for (const child of all.filter(t => t.parent_task_id === parent.id || t.recurrence_parent_id === parent.id)) {
      if (!tasks.some(t => t.id === child.id)) tasks.push(child)
    }
    return tasks
  }

  async run(args: Record<string, unknown>, projectId?: string): Promise<unknown> {
    this.shutdown.signal.throwIfAborted()
    const task = this.task(args.task_id, projectId)
    const action = args.action === 'close' ? 'complete' : args.action
    if (action !== 'complete' && action !== 'delete') throw new Error('Choose complete, close, or delete.')
    if (this.pending) throw new Error('A task action is already waiting or running. Do not submit another action yet.')
    const job = this.perform(task, action, projectId)
    this.pending = job
    try { return await job } finally { this.pending = undefined }
  }

  private async perform(task: TaskRecord, action: 'complete' | 'delete', projectId?: string): Promise<unknown> {
    if (action === 'complete' && task.status === TaskStatus.Completed) return { success: true, taskId: task.id, status: 'completed', alreadyCompleted: true }
    const affected = action === 'delete' ? this.tree(task) : [task]
    for (const item of affected) {
      this.task(item.id, projectId)
      if (this.db.getSetting(`workflo-completion:${item.id}`) || this.db.getSetting(`workflo-upload:${item.id}`)) throw new Error('This task has a pending Workflo command. Sync and resolve that command before completing or deleting it.')
    }
    const owners = [...new Set(affected.flatMap(t => {
      const step = this.responsibilities.stepForTask(t.id)
      return step ? [step.responsibilityId] : []
    }))]
    const agreements = this.responsibilities.snapshot().responsibilities.filter(r => owners.includes(r.id))
    const snapshot = fingerprint(affected)
    const sourceSnapshot = JSON.stringify(task.source_id ? this.db.getTaskSource(task.source_id) : null)
    const account = this.db.getSetting('workflo-sync-scope')
    const unchanged = () => {
      const current = this.task(task.id, projectId)
      if (fingerprint(action === 'delete' ? this.tree(current) : [current]) !== snapshot ||
        JSON.stringify(current.source_id ? this.db.getTaskSource(current.source_id) : null) !== sourceSnapshot ||
        this.db.getSetting('workflo-sync-scope') !== account || affected.some(t => this.db.getSetting(`workflo-completion:${t.id}`) || this.db.getSetting(`workflo-upload:${t.id}`))) throw new Error('The task or source changed. Nothing was deleted or completed; inspect it and confirm again. Agents and responsibilities may already have been stopped.')
    }
    const label = action === 'delete' ? 'Delete' : 'Complete'
    const source = task.source_id ? this.db.getTaskSource(task.source_id)?.name ?? task.source : 'Local task'
    const approved = await this.confirm({ title: `${label} “${task.title}”?`, confirmLabel: `${label} task`, signal: this.shutdown.signal,
      detail: `Task: ${task.id}\nSource: ${source}\n` +
        (action === 'delete' ? `Delete this local task, its ${affected.length - 1} dependent tasks (subtasks and recurring instances), attachments and transcripts. Working checkouts are retained. A linked source is not deleted and may restore the task on sync.\n` : `Run source action: ${task.output_fields.find(f => f.id === 'action')?.value || PluginActionId.Complete}. Submitted output fields: ${JSON.stringify(task.output_fields)}. ${task.source_id ? 'Completion requires confirmation from this source.' : 'This local task must first be sent to Workflo; a Workflo connection, eligible agent and skills are required. Completion requires Workflo confirmation.'}\n`) +
        (agreements.length ? `Stop and cancel these responsibilities so they cannot schedule replacement work: ${agreements.map(r => r.agreement.title).join(', ')}. Their saved agreements and reports remain.\n` : '') +
        'Active agents for the affected tasks will be stopped before changing the tasks.' })
    if (!approved || this.shutdown.signal.aborted) return { success: false, cancelled: true, taskId: task.id }
    unchanged()
    const latest = this.responsibilities.snapshot().responsibilities.filter(r => owners.includes(r.id))
    if (JSON.stringify(latest) !== JSON.stringify(agreements)) throw new Error('The responsibility changed while confirmation was open. Review it again.')
    return this.agents.withStoppedTasks(affected.map(t => t.id), async () => {
      this.shutdown.signal.throwIfAborted()
      unchanged()
      if (action === 'delete') {
        // Delete children explicitly so their owned attachments and transcripts are cleaned too.
        for (const item of [...affected].reverse()) {
          this.db.deleteTask(item.id)
          this.notify('task:deleted', { taskId: item.id })
        }
        this.notify('tasks:refresh', {})
        return { success: true, taskId: task.id, deletedTaskIds: affected.map(t => t.id) }
      }
      const result = await this.sync.completeTask(task.id)
      this.notify('tasks:refresh', {})
      return { ...result, taskId: task.id, status: this.db.getTask(task.id)?.status }
    }, async () => {
      for (const owner of latest) await this.responsibilities.act(owner.id, owner.revision, 'cancel')
    })
  }

  async stop(): Promise<void> {
    this.shutdown.abort()
    await Promise.allSettled(this.pending ? [this.pending] : [])
  }
}
