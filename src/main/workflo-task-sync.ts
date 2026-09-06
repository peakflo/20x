import type { DatabaseManager, TaskRecord, UpdateTaskData } from './database'
import type { WorkfloTask } from './workflo-api-client'
import { TaskStatus } from '../shared/constants'

/** The server snapshot is a cache. No local status can grant completion. */
export function isWorkfloLinkedTask(db: DatabaseManager, task: TaskRecord): boolean {
  return !!task.external_id && !!task.source_id &&
    db.getTaskSource(task.source_id)?.plugin_id === 'peakflo'
}

export function serverTaskSnapshot(db: DatabaseManager, id: string): WorkfloTask | undefined {
  const value = db.getSetting(`workflo-task:${id}`)
  return value ? JSON.parse(value) as WorkfloTask : undefined
}

export function saveServerTaskSnapshot(db: DatabaseManager, id: string, task: WorkfloTask): void {
  db.setSetting(`workflo-task:${id}`, JSON.stringify(task))
}

export function pendingServerTaskFields(db: DatabaseManager, id: string): UpdateTaskData {
  const value = db.getSetting(`workflo-update:${id}`)
  return value ? JSON.parse(value).fields : {}
}

export function serverTaskStatus(status: string): TaskStatus {
  if (Object.values(TaskStatus).includes(status as TaskStatus)) return status as TaskStatus
  return status === 'in_progress' ? TaskStatus.Triaging : TaskStatus.NotStarted
}

/** Resolve server IDs through the existing enterprise resource links. */
export function serverTaskFields(db: DatabaseManager, task: WorkfloTask): UpdateTaskData {
  const result: UpdateTaskData = {
    status: serverTaskStatus(task.status),
    auto_start_agent: false,
    auto_complete_without_review: false,
    // The server owns the schedule. Keep it in the snapshot for display;
    // never give it to the local recurrence scheduler.
    is_recurring: false,
    recurrence_pattern: null,
    next_occurrence_at: null
  }
  if (task.agentId !== undefined) {
    result.agent_id = db.getAgents().find(a =>
      (a.config as Record<string, unknown>).enterprise_agent_id === task.agentId)?.id ?? null
  }
  if (task.skillIds !== undefined) {
    result.skill_ids = db.getSkills().filter(s => s.enterprise_skill_id && task.skillIds!.includes(s.enterprise_skill_id)).map(s => s.id)
  }
  return result
}
