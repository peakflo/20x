import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeTask } from '../../test/helpers/task-fixtures'
import type { DatabaseManager } from './database'
import { updateTaskFromUser, finishSessionFeedback } from './session-feedback'

describe('session feedback completion', () => {
  let db: DatabaseManager
  let taskId: string
  beforeEach(() => {
    db = createTestDb().db
    const agent = db.createAgent({name: 'Learning agent', server_url: '', config: {}, is_default: false})!
    const source = db.createTaskSource({name: 'dmitry ai tasks', plugin_id: 'peakflo', mcp_server_id: null})!
    taskId = db.createTask(makeTask({source_id: source.id, external_id: 'remote-1', source: 'Notion',
      status: 'ready_for_review', output_fields: [{id: 'action', name: 'Action', type: 'text', value: 'approve'}]}))!.id
    db.updateTask(taskId, {agent_id: agent.id})
  })
  afterEach(() => db.close())

  it.each([true, false])('starts learning and honors source choice %s after learning', async completeAtSource => {
    const executeAction = vi.fn().mockResolvedValue({success: true})
    updateTaskFromUser(db, taskId, {status: 'agent_learning', feedback_rating: 4, feedback_comment: 'Useful', complete_at_source: completeAtSource})
    expect(db.getTask(taskId)).toMatchObject({status: 'agent_learning', complete_at_source: completeAtSource})
    expect(executeAction).not.toHaveBeenCalled()
    db.updateTask(taskId, {status: 'ready_for_review'}, 'workflo-server')
    expect(db.getTask(taskId)?.status).toBe('agent_learning')
    db.updateTask(taskId, {status: 'ready_for_review'})
    expect(db.getTask(taskId)?.status).toBe('agent_learning')
    await finishSessionFeedback(db, {executeAction} as never, taskId)
    expect(db.getTask(taskId)?.status).toBe('completed')
    if (completeAtSource) expect(executeAction).toHaveBeenCalledWith('approve', expect.objectContaining({id: taskId}), undefined, expect.any(String))
    else expect(executeAction).not.toHaveBeenCalled()
    await finishSessionFeedback(db, {executeAction} as never, taskId)
    expect(executeAction).toHaveBeenCalledTimes(completeAtSource ? 1 : 0)
  })

  it('does not authorize completion without a user feedback request', async () => {
    const executeAction = vi.fn()
    expect(() => db.updateTask(taskId, {status: 'agent_learning', feedback_rating: 4})).toThrow()
    await finishSessionFeedback(db, {executeAction} as never, taskId)
    expect(executeAction).not.toHaveBeenCalled()
    expect(db.getTask(taskId)?.status).toBe('ready_for_review')
  })

  it('leaves the task open if the source action fails after learning', async () => {
    updateTaskFromUser(db, taskId, {status: 'agent_learning', feedback_rating: 4, complete_at_source: true})
    const executeAction = vi.fn().mockResolvedValue({success: false, error: 'Notion unavailable'})
    await expect(finishSessionFeedback(db, {executeAction} as never, taskId)).rejects.toThrow('Notion unavailable')
    expect(db.getTask(taskId)?.status).toBe('ready_for_review')
  })

  it('cancels pending completion if learning cannot start', async () => {
    updateTaskFromUser(db, taskId, {status: 'agent_learning', feedback_rating: 4, complete_at_source: true})
    updateTaskFromUser(db, taskId, {status: 'ready_for_review'})
    const executeAction = vi.fn()
    await finishSessionFeedback(db, {executeAction} as never, taskId)
    expect(executeAction).not.toHaveBeenCalled()
  })
})
