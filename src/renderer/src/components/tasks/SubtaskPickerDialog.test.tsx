import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SubtaskPickerDialog } from './SubtaskPickerDialog'
import { TaskStatus, type WorkfloTask } from '@/types'

function makeTask(id: string, title: string, status = TaskStatus.NotStarted): WorkfloTask {
  return {
    id,
    title,
    description: '',
    type: 'general',
    priority: 'medium',
    status,
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
  it('shows each subtask status', () => {
    render(
      <SubtaskPickerDialog
        open
        onOpenChange={vi.fn()}
        subtasks={[
          makeTask('sub-1', 'First subtask', TaskStatus.AgentWorking),
          makeTask('sub-2', 'Second subtask', TaskStatus.ReadyForReview)
        ]}
        onSelect={vi.fn()}
      />
    )

    expect(screen.getByText('Agent Working')).toBeInTheDocument()
    expect(screen.getByText('Ready for Review')).toBeInTheDocument()
  })

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

  it('closes only the popup when Escape is pressed', () => {
    const onOpenChange = vi.fn()
    let parentClosed = false
    const closeParentUnlessHandled = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) parentClosed = true
    }
    window.addEventListener('keydown', closeParentUnlessHandled)

    try {
      render(
        <SubtaskPickerDialog
          open
          onOpenChange={onOpenChange}
          subtasks={[makeTask('sub-1', 'First subtask')]}
          onSelect={vi.fn()}
        />
      )

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(parentClosed).toBe(false)
    } finally {
      window.removeEventListener('keydown', closeParentUnlessHandled)
    }
  })
})
