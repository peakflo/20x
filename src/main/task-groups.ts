import { randomUUID } from 'node:crypto'
import type { DatabaseManager } from './database'
import type { TaskGroup, TaskGroupsSnapshot } from '../shared/task-groups'
import { isMastermindTask } from '../shared/responsibilities'

interface SavedGroups {
  groups: TaskGroup[]
  membership: Record<string, string | null>
  executions: Record<string, string | null>
}

/** Local organization only; execution provenance remains in responsibility steps. */
export class TaskGroups {
  onChanged = (): void => {}
  constructor(private readonly db: DatabaseManager) {}

  // ponytail: one local settings value; normalize only if catalog size makes rewrites costly.
  private read(): SavedGroups {
    return JSON.parse(this.db.getSetting('task-groups') ?? '{"groups":[],"membership":{},"executions":{}}')
  }

  private save(state: SavedGroups): void {
    this.db.setSetting('task-groups', JSON.stringify(state))
    this.onChanged()
  }

  snapshot(): TaskGroupsSnapshot {
    const state = this.read()
    const tasks = new Map(this.db.getTasks().map(t => [t.id, t]))
    const membership: Record<string, string> = {}
    const groupIds = new Set(state.groups.map(g => g.id))
    const resolve = (id: string, seen = new Set<string>()): string | null => {
      if (seen.has(id)) return null
      seen.add(id)
      if (Object.hasOwn(state.membership, id)) return state.membership[id]
      const task = tasks.get(id)
      const parent = task?.parent_task_id ?? task?.recurrence_parent_id
      return parent ? resolve(parent, seen) : null
    }
    for (const id of tasks.keys()) {
      const groupId = resolve(id)
      if (groupId && groupIds.has(groupId) && !isMastermindTask(id)) membership[id] = groupId
    }
    return { groups: state.groups, membership, executions: state.executions }
  }

  get(id: unknown, projectId?: string): TaskGroup {
    const group = typeof id === 'string' ? this.read().groups.find(g => g.id === id) : undefined
    if (!group) throw new Error('Group not found. Refresh the Groups list.')
    if (projectId && group.projectId !== projectId) throw new Error('This Group belongs to another project. Use that project or All tasks in Mastermind.')
    return group
  }

  private text(value: unknown, name: string, max: number, required = false): string {
    if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw new Error(`${name} must be ${required ? '1' : '0'}–${max} characters.`)
    return value.trim()
  }

  create(name: unknown, description: unknown = '', projectId: string | null = null): TaskGroup {
    const group: TaskGroup = { id: randomUUID(), name: this.text(name, 'Group name', 120, true), description: this.text(description, 'Description', 2000), projectId, createdAt: new Date().toISOString() }
    const state = this.read(); state.groups.push(group); this.save(state)
    return group
  }

  update(id: string, name?: unknown, description?: unknown): void {
    this.get(id)
    const state = this.read()
    const group = state.groups.find(g => g.id === id)!
    if (name !== undefined) group.name = this.text(name, 'Group name', 120, true)
    if (description !== undefined) group.description = this.text(description, 'Description', 2000)
    this.save(state)
  }

  assign(taskIds: string[], groupId: string | null): void {
    if (groupId !== null) this.get(groupId)
    for (const id of taskIds) if (isMastermindTask(id) || !this.db.getTask(id)) throw new Error('Choose existing tasks, not Mastermind conversations.')
    const state = this.read()
    for (const id of taskIds) state.membership[id] = groupId
    this.save(state)
  }

  assignExecution(id: string, groupId: string | null): void {
    if (groupId !== null) this.get(groupId)
    const state = this.read(); state.executions[id] = groupId; this.save(state)
  }

  admit(taskId: string, groupId: string | null): void {
    if (this.db.getTask(taskId) && !Object.hasOwn(this.read().membership, taskId)) this.assign([taskId], groupId)
  }

  ensureExecution(id: string, name: string, projectId: string, selected?: string | null): string | null {
    const state = this.read()
    if (Object.hasOwn(state.executions, id)) return state.executions[id]
    const groupId = selected === null ? null : selected ?? this.create(name, '', projectId).id
    if (groupId) this.get(groupId, projectId)
    this.assignExecution(id, groupId)
    return groupId
  }

  remove(id: string): void {
    this.get(id)
    const state = this.read()
    for (const [taskId, groupId] of Object.entries(this.snapshot().membership)) if (groupId === id) state.membership[taskId] = null
    for (const [executionId, groupId] of Object.entries(state.executions)) if (groupId === id) state.executions[executionId] = null
    state.groups = state.groups.filter(g => g.id !== id)
    this.save(state)
  }
}
