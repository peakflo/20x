import { describe, it, expect } from 'vitest'
import { TaskStatus, TASK_STATUSES } from './constants'

describe('TaskStatus enum', () => {
  it('has exactly 8 statuses', () => {
    const values = Object.values(TaskStatus)
    expect(values).toHaveLength(8)
  })

  it('has expected string values', () => {
    expect(TaskStatus.NotStarted).toBe('not_started')
    expect(TaskStatus.Triaging).toBe('triaging')
    expect(TaskStatus.AgentWorking).toBe('agent_working')
    expect(TaskStatus.ReadyForReview).toBe('ready_for_review')
    expect(TaskStatus.AgentLearning).toBe('agent_learning')
    expect(TaskStatus.Completed).toBe('completed')
    expect(TaskStatus.Cancelled).toBe('cancelled')
    expect(TaskStatus.Expired).toBe('expired')
  })
})

describe('TASK_STATUSES array', () => {
  it('contains all enum values', () => {
    const values = TASK_STATUSES.map((s) => s.value)
    expect(values).toContain(TaskStatus.NotStarted)
    expect(values).toContain(TaskStatus.Triaging)
    expect(values).toContain(TaskStatus.AgentWorking)
    expect(values).toContain(TaskStatus.ReadyForReview)
    expect(values).toContain(TaskStatus.AgentLearning)
    expect(values).toContain(TaskStatus.Completed)
  })

  it('each entry has a value and label', () => {
    for (const status of TASK_STATUSES) {
      expect(status).toHaveProperty('value')
      expect(status).toHaveProperty('label')
      expect(typeof status.label).toBe('string')
      expect(status.label.length).toBeGreaterThan(0)
    }
  })

  it('keeps server-owned closed states out of the local status picker', () => {
    expect(TASK_STATUSES).toHaveLength(6)
    expect(TASK_STATUSES.map((status) => status.value)).not.toContain(TaskStatus.Cancelled)
    expect(TASK_STATUSES.map((status) => status.value)).not.toContain(TaskStatus.Expired)
  })
})
