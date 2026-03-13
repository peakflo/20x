import { describe, it, expect, vi, beforeEach } from 'vitest'

import { EnterpriseStateSync } from './enterprise-state-sync'
import type { TaskRecord } from './database'

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    title: 'Test Task',
    description: '',
    status: 'not_started',
    external_id: 'ext-1',
    source_id: 'src-1',
    created_at: '2026-03-01T00:00:00.000Z',
    updated_at: '2026-03-09T00:00:00.000Z',
    ...overrides
  } as TaskRecord
}

describe('EnterpriseStateSync', () => {
  let stateSync: EnterpriseStateSync
  let mockApiClient: {
    sendSyncEvents: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    mockApiClient = {
      sendSyncEvents: vi.fn().mockResolvedValue({ ok: true, inserted: 0 })
    }
    stateSync = new EnterpriseStateSync(mockApiClient as never)
    stateSync.setUserName('Test User')
  })

  describe('event recording', () => {
    it('records task status change events', () => {
      const task = makeTask()
      stateSync.recordTaskStatusChange(task, 'not_started', 'agent_working')

      expect(stateSync.pendingCount).toBe(1)
    })

    it('records task created events', () => {
      const task = makeTask()
      stateSync.recordTaskCreated(task)

      expect(stateSync.pendingCount).toBe(1)
    })

    it('records task completed events', () => {
      const task = makeTask()
      stateSync.recordTaskCompleted(task)

      expect(stateSync.pendingCount).toBe(1)
    })

    it('records agent run started events', () => {
      const task = makeTask()
      stateSync.recordAgentRunStarted(task, 'Claude Agent')

      expect(stateSync.pendingCount).toBe(1)
    })

    it('records agent run completed events', () => {
      const task = makeTask()
      stateSync.recordAgentRunCompleted(task, {
        agentName: 'Claude',
        durationMinutes: 5,
        messageCount: 10,
        success: true
      })

      expect(stateSync.pendingCount).toBe(1)
    })

    it('records agent run failed events', () => {
      const task = makeTask()
      stateSync.recordAgentRunCompleted(task, {
        success: false
      })

      expect(stateSync.pendingCount).toBe(1)
    })

    it('records feedback events', () => {
      const task = makeTask()
      stateSync.recordFeedbackSubmitted(task, 4.5)

      expect(stateSync.pendingCount).toBe(1)
    })

    it('accumulates multiple events', () => {
      const task = makeTask()
      stateSync.recordTaskStatusChange(task, 'not_started', 'triaging')
      stateSync.recordTaskStatusChange(task, 'triaging', 'agent_working')
      stateSync.recordAgentRunStarted(task)

      expect(stateSync.pendingCount).toBe(3)
    })
  })

  describe('flush', () => {
    it('sends pending events to API', async () => {
      const task = makeTask()
      stateSync.recordTaskStatusChange(task, 'not_started', 'agent_working')
      stateSync.recordTaskCompleted(task)

      mockApiClient.sendSyncEvents.mockResolvedValue({ ok: true, inserted: 2 })

      await stateSync.flush()

      expect(mockApiClient.sendSyncEvents).toHaveBeenCalledTimes(1)
      const events = mockApiClient.sendSyncEvents.mock.calls[0][0]
      expect(events).toHaveLength(2)
      expect(events[0].eventType).toBe('task_status_changed')
      expect(events[0].entityId).toBe('ext-1')
      expect(events[0].userName).toBe('Test User')
      expect(events[1].eventType).toBe('task_completed')
    })

    it('does not send events if none pending', async () => {
      await stateSync.flush()

      expect(mockApiClient.sendSyncEvents).not.toHaveBeenCalled()
    })

    it('re-queues events on API failure', async () => {
      const task = makeTask()
      stateSync.recordTaskCreated(task)

      mockApiClient.sendSyncEvents.mockRejectedValue(new Error('network error'))

      await stateSync.flush()

      // Events should be re-queued
      expect(stateSync.pendingCount).toBe(1)
    })

    it('prevents concurrent flushes', async () => {
      const task = makeTask()
      stateSync.recordTaskCreated(task)

      // Make sendSyncEvents slow
      let resolveFirst: () => void
      mockApiClient.sendSyncEvents.mockImplementation(
        () => new Promise<{ ok: boolean; inserted: number }>((resolve) => {
          resolveFirst = () => resolve({ ok: true, inserted: 1 })
        })
      )

      const flush1 = stateSync.flush()
      const flush2 = stateSync.flush() // Should be a no-op

      resolveFirst!()
      await flush1
      await flush2

      // Only called once (second flush was skipped)
      expect(mockApiClient.sendSyncEvents).toHaveBeenCalledTimes(1)
    })

    it('clears pending count after successful flush', async () => {
      const task = makeTask()
      stateSync.recordTaskCreated(task)
      stateSync.recordTaskStatusChange(task, 'not_started', 'triaging')

      expect(stateSync.pendingCount).toBe(2)

      mockApiClient.sendSyncEvents.mockResolvedValue({ ok: true, inserted: 2 })
      await stateSync.flush()

      expect(stateSync.pendingCount).toBe(0)
    })
  })

  describe('entity ID resolution', () => {
    it('uses external_id for entity ID if available', async () => {
      const task = makeTask({ external_id: 'my-ext-id' })
      stateSync.recordTaskCreated(task)

      await stateSync.flush()

      const events = mockApiClient.sendSyncEvents.mock.calls[0][0]
      expect(events[0].entityId).toBe('my-ext-id')
    })

    it('falls back to local ID when external_id is null', async () => {
      const task = makeTask({ external_id: null })
      stateSync.recordTaskCreated(task)

      await stateSync.flush()

      const events = mockApiClient.sendSyncEvents.mock.calls[0][0]
      expect(events[0].entityId).toBe('task-1')
    })
  })

  describe('event data', () => {
    it('includes agent run metadata in eventData', async () => {
      const task = makeTask()
      stateSync.recordAgentRunCompleted(task, {
        agentName: 'Claude',
        durationMinutes: 5.3,
        messageCount: 12,
        success: true
      })

      await stateSync.flush()

      const events = mockApiClient.sendSyncEvents.mock.calls[0][0]
      expect(events[0].eventType).toBe('agent_run_completed')
      expect(events[0].eventData).toEqual({
        agentName: 'Claude',
        durationMinutes: 5.3,
        messageCount: 12,
        success: true
      })
    })

    it('includes feedback rating in eventData', async () => {
      const task = makeTask()
      stateSync.recordFeedbackSubmitted(task, 4.5)

      await stateSync.flush()

      const events = mockApiClient.sendSyncEvents.mock.calls[0][0]
      expect(events[0].eventType).toBe('feedback_submitted')
      expect(events[0].eventData).toEqual({ rating: 4.5 })
      expect(events[0].newValue).toBe('4.5')
    })

    it('marks failed agent runs with correct eventType', async () => {
      const task = makeTask()
      stateSync.recordAgentRunCompleted(task, { success: false })

      await stateSync.flush()

      const events = mockApiClient.sendSyncEvents.mock.calls[0][0]
      expect(events[0].eventType).toBe('agent_run_failed')
      expect(events[0].eventData?.success).toBe(false)
    })

    it('includes task source info in status change eventData', async () => {
      const task = makeTask({ external_id: 'ext-123', source_id: 'src-abc' })
      stateSync.recordTaskStatusChange(task, 'not_started', 'triaging')

      await stateSync.flush()

      const events = mockApiClient.sendSyncEvents.mock.calls[0][0]
      expect(events[0].eventData).toEqual({
        localTaskId: 'task-1',
        externalId: 'ext-123',
        sourceId: 'src-abc'
      })
    })
  })
})
