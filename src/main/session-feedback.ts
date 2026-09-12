import type { DatabaseManager, UpdateTaskData } from './database'
import type { SyncManager } from './sync-manager'
import { TaskStatus } from '../shared/constants'
import { getTaskCompletionAction } from '../shared/task-completion'

const feedbackKey = (taskId: string) => `session-feedback-completion:${taskId}`

/** Called only by the desktop/mobile user write routes, not the agent task API. */
export function updateTaskFromUser(db: DatabaseManager, taskId: string, data: UpdateTaskData) {
  if (data.status === TaskStatus.AgentLearning && data.feedback_rating !== undefined) {
    if (!Number.isInteger(data.feedback_rating) || data.feedback_rating! < 1 || data.feedback_rating! > 5) {
      throw new Error('Select a rating from 1 to 5.')
    }
    const task = db.getTask(taskId)
    if (!task?.agent_id) throw new Error('An agent is required for session learning.')
    if (task.status === TaskStatus.Completed) throw new Error('This task is already completed.')
    if (task.source_id && typeof data.complete_at_source !== 'boolean') throw new Error('Select a source completion option.')
    const result = db.updateTask(taskId, data, 'session-feedback')
    db.setSetting(feedbackKey(taskId), JSON.stringify({ completeAtSource: data.complete_at_source !== false }))
    return result
  }
  if (data.status === TaskStatus.ReadyForReview && db.getSetting(feedbackKey(taskId))) {
    db.deleteSetting(feedbackKey(taskId))
    return db.updateTask(taskId, data, 'session-feedback')
  }
  return db.updateTask(taskId, data)
}

/** Consume the user's choice only after the learning session and skill sync finish. */
export async function finishSessionFeedback(db: DatabaseManager, sync: SyncManager | undefined, taskId: string) {
  const pending = db.getSetting(feedbackKey(taskId))
  if (!pending) return undefined
  const task = db.getTask(taskId)
  if (!task || task.status !== TaskStatus.AgentLearning) return undefined
  const { completeAtSource } = JSON.parse(pending) as { completeAtSource: boolean }
  db.deleteSetting(feedbackKey(taskId))
  try {
    if (db.getSubtasks(taskId).some(child => child.status !== TaskStatus.Completed && child.status !== TaskStatus.ReadyForReview)) {
      throw new Error('Subtasks must finish before this task can complete.')
    }
    if (task.source_id && completeAtSource) {
      if (!sync) throw new Error('Task source is unavailable.')
      const result = await sync.executeAction(getTaskCompletionAction(task.output_fields), task, undefined, task.source_id)
      if (!result.success) throw new Error(result.error || 'Source completion failed.')
    }
    return db.updateTask(taskId, { status: TaskStatus.Completed }, 'session-feedback')
  } catch (error) {
    db.updateTask(taskId, { status: TaskStatus.ReadyForReview }, 'session-feedback')
    throw error
  }
}
