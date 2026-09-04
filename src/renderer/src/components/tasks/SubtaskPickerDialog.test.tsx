import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SubtaskPickerDialog } from './SubtaskPickerDialog'
import { TaskStatus, type WorkfloTask } from '@/types'

function makeTask(id: string, title: string): WorkfloTask {
  return {
    id,
    title,
    description: '',
    type: 'general',
    priority: 'medium',
    status: TaskStatus.NotStarted,
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
    source: 'manual',
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
    auto_start_agent: false,
    auto_complete_without_review: false,
    complete_at_source: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    parent_task_id: 'parent-1',
    sort_order: 0
  }
}

afterEach(cleanup)

describe('SubtaskPickerDialog', () => {
  it('opens the highlighted subtask with arrow keys and Enter', () => {
    const onSelect = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <SubtaskPickerDialog
        open
        onOpenChange={onOpenChange}
        subtasks={[makeTask('sub-1', 'First subtask'), makeTask('sub-2', 'Second subtask')]}
        onSelect={onSelect}
      />
    )

    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'ArrowDown' })
    fireEvent.keyDown(dialog, { key: 'Enter' })

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSelect).toHaveBeenCalledWith('sub-2')
  })

  it('supports J and K navigation', () => {
    const onSelect = vi.fn()
    render(
      <SubtaskPickerDialog
        open
        onOpenChange={vi.fn()}
        subtasks={[makeTask('sub-1', 'First subtask'), makeTask('sub-2', 'Second subtask')]}
        onSelect={onSelect}
      />
    )

    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'j' })
    fireEvent.keyDown(dialog, { key: 'k' })
    fireEvent.keyDown(dialog, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledWith('sub-1')
  })
})
