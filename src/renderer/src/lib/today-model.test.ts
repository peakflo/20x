import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { TaskStatus } from '@/types'
import { buildTodayModel, greetingFor, needsYouHeadline, type TodayTask } from './today-model'

// Thursday 1 October 2026, 09:30 local time.
const NOW = new Date(2026, 9, 1, 9, 30)
const day = (offset: number) => new Date(2026, 9, 1 + offset, 12).toISOString()

// The overdue and snooze rules come from lib/utils and read the clock.
beforeAll(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterAll(() => {
  vi.useRealTimers()
})

function task(id: string, status: TaskStatus, extra: Partial<TodayTask> = {}): TodayTask {
  return {
    id,
    title: `Task ${id}`,
    status,
    priority: 'medium',
    due_date: null,
    agent_id: null,
    snoozed_until: null,
    parent_task_id: null,
    ...extra
  }
}

describe('buildTodayModel', () => {
  it('puts approvals first, then reviews (overdue first), then overdue tasks', () => {
    const model = buildTodayModel(
      [
        task('a', TaskStatus.AgentWorking),
        task('r1', TaskStatus.ReadyForReview),
        task('r2', TaskStatus.ReadyForReview, { due_date: day(-1) }),
        task('o', TaskStatus.NotStarted, { due_date: day(-2) })
      ],
      [{ taskId: 'a', sessionId: 's1', status: 'waiting_approval', pendingApproval: { action: 'run tests', description: '' } }]
    )
    expect(model.needsYou.map((item) => `${item.kind}:${item.taskId}`)).toEqual([
      'approval:a',
      'review:r2',
      'review:r1',
      'overdue:o'
    ])
    // A task waiting for approval is not also listed as running.
    expect(model.running).toEqual([])
  })

  it('lists running work and ranks what is next by priority, then due date', () => {
    const model = buildTodayModel(
      [
        task('w', TaskStatus.AgentWorking, { agent_id: 'agent' }),
        task('t', TaskStatus.Triaging),
        task('low', TaskStatus.NotStarted, { priority: 'low' }),
        task('hi-late', TaskStatus.NotStarted, { priority: 'high', due_date: day(5) }),
        task('hi-soon', TaskStatus.NotStarted, { priority: 'high', due_date: day(1) })
      ],
      []
    )
    expect(model.running.map((item) => `${item.taskId}:${item.status}`)).toEqual(['w:working', 't:triaging'])
    expect(model.upNext.map((item) => item.taskId)).toEqual(['hi-soon', 'hi-late', 'low'])
  })

  it('leaves out subtasks and snoozed tasks', () => {
    const model = buildTodayModel(
      [
        task('sub', TaskStatus.NotStarted, { parent_task_id: 'p' }),
        task('snoozed', TaskStatus.NotStarted, { snoozed_until: day(1) })
      ],
      []
    )
    expect(model.upNext).toEqual([])
  })

  it('totals not-started and completed top-level tasks', () => {
    const model = buildTodayModel(
      [
        task('n', TaskStatus.NotStarted),
        task('c1', TaskStatus.Completed),
        task('c2', TaskStatus.Completed),
        task('sub', TaskStatus.Completed, { parent_task_id: 'c1' })
      ],
      []
    )
    expect(model.totals).toEqual({ notStarted: 1, completed: 2 })
  })
})

describe('wording', () => {
  it('writes the headline and greeting', () => {
    expect(needsYouHeadline(0)).toBe('Nothing needs you right now.')
    expect(needsYouHeadline(2)).toBe('Two things need you.')
    expect(needsYouHeadline(9)).toBe('9 things need you.')
    expect(greetingFor(NOW)).toBe('Good morning.')
    expect(greetingFor(new Date(2026, 9, 1, 20))).toBe('Good evening.')
  })
})
