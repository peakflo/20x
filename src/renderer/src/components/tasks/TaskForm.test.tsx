import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { TaskForm } from './TaskForm'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'

afterEach(cleanup)

function makeTask(overrides: Partial<WorkfloTask> = {}): WorkfloTask {
  return {
    id: 'task-1',
    title: 'Test Task',
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
    auto_start_agent: false,
    auto_complete_without_review: false,
    parent_task_id: null,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides
  }
}

describe('TaskForm – auto-start / auto-complete toggles', () => {
  it('does not show automation section when recurrence is disabled', () => {
    render(<TaskForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.queryByTestId('auto-flags-section')).toBeNull()
    expect(screen.queryByText('Auto-start agent on new instances')).toBeNull()
    expect(screen.queryByText('Auto-complete without review')).toBeNull()
  })

  it('shows automation section when editing a recurring task', () => {
    const task = makeTask({
      is_recurring: true,
      recurrence_pattern: '0 9 * * 1-5',
      agent_id: 'agent-1'
    })

    render(<TaskForm task={task} onSubmit={vi.fn()} onCancel={vi.fn()} />)

    expect(screen.getByTestId('auto-flags-section')).toBeDefined()
    expect(screen.getByText('Auto-start agent on new instances')).toBeDefined()
    expect(screen.getByText('Auto-complete without review')).toBeDefined()
  })

  it('initializes toggles from existing task values', () => {
    const task = makeTask({
      is_recurring: true,
      recurrence_pattern: '0 9 * * 1-5',
      agent_id: 'agent-1',
      auto_start_agent: true,
      auto_complete_without_review: true
    })

    render(<TaskForm task={task} onSubmit={vi.fn()} onCancel={vi.fn()} />)

    const autoStartCheckbox = screen.getByTestId('form-auto-start-toggle').querySelector('input[type="checkbox"]') as HTMLInputElement
    const autoCompleteCheckbox = screen.getByTestId('form-auto-complete-toggle').querySelector('input[type="checkbox"]') as HTMLInputElement

    expect(autoStartCheckbox.checked).toBe(true)
    expect(autoCompleteCheckbox.checked).toBe(true)
  })

  it('initializes toggles as unchecked when task has them false', () => {
    const task = makeTask({
      is_recurring: true,
      recurrence_pattern: '0 9 * * 1-5',
      auto_start_agent: false,
      auto_complete_without_review: false
    })

    render(<TaskForm task={task} onSubmit={vi.fn()} onCancel={vi.fn()} />)

    const autoStartCheckbox = screen.getByTestId('form-auto-start-toggle').querySelector('input[type="checkbox"]') as HTMLInputElement
    const autoCompleteCheckbox = screen.getByTestId('form-auto-complete-toggle').querySelector('input[type="checkbox"]') as HTMLInputElement

    expect(autoStartCheckbox.checked).toBe(false)
    expect(autoCompleteCheckbox.checked).toBe(false)
  })

  it('toggles auto-start checkbox on click', () => {
    const task = makeTask({
      is_recurring: true,
      recurrence_pattern: '0 9 * * 1-5'
    })

    render(<TaskForm task={task} onSubmit={vi.fn()} onCancel={vi.fn()} />)

    const checkbox = screen.getByTestId('form-auto-start-toggle').querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox.checked).toBe(false)

    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(true)

    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(false)
  })

  it('toggles auto-complete checkbox on click', () => {
    const task = makeTask({
      is_recurring: true,
      recurrence_pattern: '0 9 * * 1-5'
    })

    render(<TaskForm task={task} onSubmit={vi.fn()} onCancel={vi.fn()} />)

    const checkbox = screen.getByTestId('form-auto-complete-toggle').querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox.checked).toBe(false)

    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(true)
  })

  it('includes auto flags in submit data when recurrence is enabled', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const task = makeTask({
      is_recurring: true,
      recurrence_pattern: '0 9 * * 1-5'
    })

    render(<TaskForm task={task} onSubmit={onSubmit} onCancel={vi.fn()} />)

    // Enable auto-start
    const autoStartCheckbox = screen.getByTestId('form-auto-start-toggle').querySelector('input[type="checkbox"]') as HTMLInputElement
    fireEvent.click(autoStartCheckbox)

    // Submit
    fireEvent.click(screen.getByText('Save Changes'))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
    const submitted = onSubmit.mock.calls[0][0]
    expect(submitted.auto_start_agent).toBe(true)
    expect(submitted.auto_complete_without_review).toBe(false)
  })

  it('resets auto flags to false in submit data when recurrence is disabled', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)

    // Create the task form without an existing task (create mode)
    // The RecurrenceEditor starts disabled so recurrencePattern is null
    render(<TaskForm onSubmit={onSubmit} onCancel={vi.fn()} />)

    // Fill required title
    fireEvent.change(screen.getByPlaceholderText('What needs to be done?'), {
      target: { value: 'My new task' }
    })

    // Submit without enabling recurrence
    fireEvent.click(screen.getByText('Create Task'))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
    const submitted = onSubmit.mock.calls[0][0]
    expect(submitted.auto_start_agent).toBe(false)
    expect(submitted.auto_complete_without_review).toBe(false)
  })
})
