import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSnoozeTick } from './use-snooze-tick'
import type { WorkfloTask } from '@/types'

// Mock ipc-client
let overdueCheckCallback: (() => void) | null = null
vi.mock('@/lib/ipc-client', () => ({
  onOverdueCheck: vi.fn((cb: () => void) => {
    overdueCheckCallback = cb
    return () => { overdueCheckCallback = null }
  })
}))

function makeTask(overrides: Partial<WorkfloTask> = {}): WorkfloTask {
  return {
    id: 'task-1',
    title: 'Test Task',
    description: '',
    type: 'general',
    priority: 'medium',
    status: 'not_started',
    assignee: '',
    due_date: null,
    labels: [],
    attachments: [],
    repos: [],
    output_fields: [],
    agent_id: null,
    session_id: null,
    external_id: null,
    source_id: null,
    source: 'local',
    skill_ids: null,
    snoozed_until: null,
    resolution: null,
    feedback_rating: null,
    feedback_comment: null,
    is_recurring: false,
    recurrence_pattern: null,
    recurrence_parent_id: null,
    last_occurrence_at: null,
    next_occurrence_at: null,
    parent_task_id: null,
    sort_order: 0,
    created_at: '2026-03-25T10:00:00.000Z',
    updated_at: '2026-03-25T10:00:00.000Z',
    ...overrides
  } as WorkfloTask
}

describe('useSnoozeTick', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    overdueCheckCallback = null
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns 0 initially', () => {
    const { result } = renderHook(() => useSnoozeTick([]))
    expect(result.current).toBe(0)
  })

  it('increments tick when overdue:check fires', () => {
    const { result } = renderHook(() => useSnoozeTick([]))
    expect(result.current).toBe(0)

    act(() => {
      overdueCheckCallback?.()
    })
    expect(result.current).toBe(1)

    act(() => {
      overdueCheckCallback?.()
    })
    expect(result.current).toBe(2)
  })

  it('schedules timer for nearest snooze expiry', () => {
    const now = new Date('2026-03-25T10:00:00.000Z')
    vi.setSystemTime(now)

    const tasks = [
      makeTask({
        id: 'task-1',
        snoozed_until: '2026-03-25T10:05:00.000Z' // 5 minutes from now
      }),
      makeTask({
        id: 'task-2',
        snoozed_until: '2026-03-26T08:00:00.000Z' // tomorrow
      })
    ]

    const { result } = renderHook(() => useSnoozeTick(tasks))
    expect(result.current).toBe(0)

    // Advance to just after the nearest expiry (5 min + 1s buffer)
    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000 + 1000)
    })
    expect(result.current).toBe(1)
  })

  it('does not schedule timer for tasks without snooze', () => {
    const tasks = [
      makeTask({ id: 'task-1', snoozed_until: null }),
      makeTask({ id: 'task-2', snoozed_until: null })
    ]

    const { result } = renderHook(() => useSnoozeTick(tasks))

    // Advance a long time — no tick should happen (except from overdue:check)
    act(() => {
      vi.advanceTimersByTime(60 * 60 * 1000)
    })
    expect(result.current).toBe(0)
  })

  it('ignores SNOOZE_SOMEDAY sentinel value', () => {
    const tasks = [
      makeTask({
        id: 'task-1',
        snoozed_until: '9999-12-31T00:00:00.000Z'
      })
    ]

    const { result } = renderHook(() => useSnoozeTick(tasks))

    act(() => {
      vi.advanceTimersByTime(60 * 60 * 1000)
    })
    // Should still be 0 — no timer was scheduled for the someday sentinel
    expect(result.current).toBe(0)
  })

  it('ignores already-expired snooze times', () => {
    vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'))

    const tasks = [
      makeTask({
        id: 'task-1',
        snoozed_until: '2026-03-25T10:00:00.000Z' // already in the past
      })
    ]

    const { result } = renderHook(() => useSnoozeTick(tasks))

    act(() => {
      vi.advanceTimersByTime(60 * 60 * 1000)
    })
    // No timer should fire for expired snoozes
    expect(result.current).toBe(0)
  })
})
