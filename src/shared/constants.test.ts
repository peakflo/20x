import { describe, it, expect } from 'vitest'
import { TaskStatus, TASK_STATUSES } from './constants'

describe('TaskStatus enum', () => {
  it('has exactly 4 statuses', () => {
    const values = Object.values(TaskStatus)
    expect(values).toHaveLength(4)
  })

  it('has expected string values', () => {
    expect(TaskStatus.NotStarted).toBe('not_started')
    expect(TaskStatus.AgentWorking).toBe('agent_working')
    expect(TaskStatus.ReadyForReview).toBe('ready_for_review')
    expect(TaskStatus.Completed).toBe('completed')
  })
})

describe('TASK_STATUSES array', () => {
  it('contains all enum values', () => {
    const values = TASK_STATUSES.map((s) => s.value)
    expect(values).toContain(TaskStatus.NotStarted)
    expect(values).toContain(TaskStatus.AgentWorking)
    expect(values).toContain(TaskStatus.ReadyForReview)
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

  it('has the same length as the enum', () => {
    expect(TASK_STATUSES).toHaveLength(Object.values(TaskStatus).length)
  })
})
