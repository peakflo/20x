import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'
import { TaskHeaderBar, TaskPrimaryAction } from './TaskHeaderBar'

function makeTask(status = TaskStatus.NotStarted): WorkfloTask {
  return {
    id: 'task-1',
    title: 'Review the redesign',
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
    parent_task_id: null,
    next_subtask_ids: [],
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z'
  }
}

const requiredProps = {
  onRename: vi.fn(),
  detailsOpen: false,
  showDetailsToggle: false,
  onToggleDetails: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn()
}

afterEach(cleanup)

describe('TaskHeaderBar', () => {
  it('keeps Complete visible alongside the current agent action', () => {
    const onComplete = vi.fn()
    render(
      <TaskHeaderBar
        {...requiredProps}
        task={makeTask()}
        action={TaskPrimaryAction.START}
        onAction={vi.fn()}
        onComplete={onComplete}
      />
    )

    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('header-cta-complete'))
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('does not duplicate Complete when it is already the primary action', () => {
    render(
      <TaskHeaderBar
        {...requiredProps}
        task={makeTask(TaskStatus.ReadyForReview)}
        action={TaskPrimaryAction.COMPLETE}
        onAction={vi.fn()}
        onComplete={vi.fn()}
      />
    )

    expect(screen.getAllByTestId('header-cta-complete')).toHaveLength(1)
  })

  it('changes status from the status badge menu', () => {
    const onStatusChange = vi.fn()
    render(
      <TaskHeaderBar
        {...requiredProps}
        task={makeTask()}
        onStatusChange={onStatusChange}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Change task status' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Ready for Review' }))

    expect(onStatusChange).toHaveBeenCalledWith(TaskStatus.ReadyForReview)
  })

  it('hides Complete after the task is completed', () => {
    render(
      <TaskHeaderBar
        {...requiredProps}
        task={makeTask(TaskStatus.Completed)}
        onComplete={vi.fn()}
      />
    )

    expect(screen.queryByTestId('header-cta-complete')).not.toBeInTheDocument()
  })
})
