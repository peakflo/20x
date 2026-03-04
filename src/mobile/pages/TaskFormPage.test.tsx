import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TaskFormPage } from './TaskFormPage'
import { useTaskStore, type Task } from '../stores/task-store'

const mockNavigate = vi.fn()

// happy-dom + React 19 can duplicate elements — use getAllBy* helpers
function queryFirst(getter: () => HTMLElement[]): HTMLElement {
  return getter()[0]
}

beforeEach(() => {
  useTaskStore.setState({ tasks: [], isLoading: false })
  vi.clearAllMocks()
})

describe('TaskFormPage — Create mode', () => {
  it('renders create form with title and description fields', () => {
    const { container } = render(<TaskFormPage onNavigate={mockNavigate} />)

    expect(container.querySelector('h1')?.textContent).toBe('New Task')
    expect(container.querySelector('input[placeholder="What needs to be done?"]')).toBeTruthy()
    expect(container.querySelector('textarea[placeholder="Add details, context, or notes..."]')).toBeTruthy()
  })

  it('disables submit when title is empty', () => {
    const { container } = render(<TaskFormPage onNavigate={mockNavigate} />)

    // Find the submit button by its distinctive class
    const buttons = container.querySelectorAll('button.bg-primary')
    const submitBtn = Array.from(buttons).find(b => b.textContent?.includes('Create Task')) as HTMLButtonElement
    expect(submitBtn).toBeTruthy()
    expect(submitBtn.disabled).toBe(true)
  })

  it('enables submit when title is filled', () => {
    const { container } = render(<TaskFormPage onNavigate={mockNavigate} />)

    const input = container.querySelector('input[placeholder="What needs to be done?"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'My new task' } })

    const buttons = container.querySelectorAll('button.bg-primary')
    const submitBtn = Array.from(buttons).find(b => b.textContent?.includes('Create Task')) as HTMLButtonElement
    expect(submitBtn.disabled).toBe(false)
  })

  it('calls createTask and navigates on submit', async () => {
    const mockTask = { id: 'new-1', title: 'Test' } as unknown as Task
    const createTaskMock = vi.fn().mockResolvedValue(mockTask)
    useTaskStore.setState({ createTask: createTaskMock } as unknown as Parameters<typeof useTaskStore.setState>[0])

    const { container } = render(<TaskFormPage onNavigate={mockNavigate} />)

    const input = container.querySelector('input[placeholder="What needs to be done?"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Test' } })

    const buttons = container.querySelectorAll('button.bg-primary')
    const submitBtn = Array.from(buttons).find(b => b.textContent?.includes('Create Task')) as HTMLButtonElement
    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Test' })
      )
      expect(mockNavigate).toHaveBeenCalledWith({ page: 'detail', taskId: 'new-1' })
    })
  })

  it('shows error when createTask fails', async () => {
    const createTaskMock = vi.fn().mockResolvedValue(null)
    useTaskStore.setState({ createTask: createTaskMock } as unknown as Parameters<typeof useTaskStore.setState>[0])

    const { container } = render(<TaskFormPage onNavigate={mockNavigate} />)

    const input = container.querySelector('input[placeholder="What needs to be done?"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Test' } })

    const buttons = container.querySelectorAll('button.bg-primary')
    const submitBtn = Array.from(buttons).find(b => b.textContent?.includes('Create Task')) as HTMLButtonElement
    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(container.textContent).toContain('Failed to create task')
    })
  })

  it('hides additional fields by default', () => {
    const { container } = render(<TaskFormPage onNavigate={mockNavigate} />)

    expect(container.textContent).toContain('Additional fields')
    // Type/Priority labels not rendered when collapsed
    const labels = Array.from(container.querySelectorAll('label')).map(l => l.textContent)
    expect(labels).not.toContain('Type')
    expect(labels).not.toContain('Priority')
  })

  it('shows additional fields when toggled', () => {
    const { container } = render(<TaskFormPage onNavigate={mockNavigate} />)

    const toggle = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Additional fields'))!
    fireEvent.click(toggle)

    const labels = Array.from(container.querySelectorAll('label')).map(l => l.textContent)
    expect(labels).toContain('Type')
    expect(labels).toContain('Priority')
    expect(labels).toContain('Due Date')
    expect(labels).toContain('Labels')
    expect(container.textContent).toContain('Output Fields')
    expect(container.textContent).toContain('Recurring Task')
  })

  it('does not show Status field in create mode', () => {
    const { container } = render(<TaskFormPage onNavigate={mockNavigate} />)

    const toggle = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Additional fields'))!
    fireEvent.click(toggle)

    const labels = Array.from(container.querySelectorAll('label')).map(l => l.textContent)
    expect(labels).not.toContain('Status')
  })

  it('navigates back to list on cancel', () => {
    const { container } = render(<TaskFormPage onNavigate={mockNavigate} />)

    const cancelBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Cancel')!
    fireEvent.click(cancelBtn)

    expect(mockNavigate).toHaveBeenCalledWith({ page: 'list' })
  })
})

describe('TaskFormPage — Edit mode', () => {
  const existingTask: Task = {
    id: 't1',
    title: 'Existing Task',
    description: 'Some description',
    type: 'coding',
    priority: 'high',
    status: 'not_started',
    assignee: '',
    due_date: '2026-06-15T00:00:00.000Z',
    labels: ['bug', 'frontend'],
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
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z'
  }

  beforeEach(() => {
    useTaskStore.setState({ tasks: [existingTask] })
  })

  it('renders edit form with pre-populated fields', async () => {
    const { container } = render(<TaskFormPage taskId="t1" onNavigate={mockNavigate} />)

    expect(container.querySelector('h1')?.textContent).toBe('Edit Task')
    await waitFor(() => {
      const titleInput = container.querySelector('input[placeholder="What needs to be done?"]') as HTMLInputElement
      expect(titleInput.value).toBe('Existing Task')
    })
  })

  it('auto-expands additional fields when task has non-default values', async () => {
    const { container } = render(<TaskFormPage taskId="t1" onNavigate={mockNavigate} />)

    // Wait for useEffect to set showMore=true (coding != general triggers it)
    await waitFor(() => {
      const labels = Array.from(container.querySelectorAll('label')).map(l => l.textContent)
      expect(labels).toContain('Type')
    })
  })

  it('shows Status field in edit mode', async () => {
    const { container } = render(<TaskFormPage taskId="t1" onNavigate={mockNavigate} />)

    await waitFor(() => {
      const labels = Array.from(container.querySelectorAll('label')).map(l => l.textContent)
      expect(labels).toContain('Status')
    })
  })

  it('calls updateTask and navigates on submit', async () => {
    const updateTaskMock = vi.fn().mockResolvedValue(true)
    useTaskStore.setState({
      tasks: [existingTask],
      updateTask: updateTaskMock
    } as unknown as Parameters<typeof useTaskStore.setState>[0])

    const { container } = render(<TaskFormPage taskId="t1" onNavigate={mockNavigate} />)

    await waitFor(() => {
      const titleInput = container.querySelector('input[placeholder="What needs to be done?"]') as HTMLInputElement
      expect(titleInput.value).toBe('Existing Task')
    })

    const titleInput = container.querySelector('input[placeholder="What needs to be done?"]') as HTMLInputElement
    fireEvent.change(titleInput, { target: { value: 'Updated Title' } })

    const buttons = container.querySelectorAll('button.bg-primary')
    const submitBtn = Array.from(buttons).find(b => b.textContent?.includes('Save Changes')) as HTMLButtonElement
    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(updateTaskMock).toHaveBeenCalledWith('t1', expect.objectContaining({ title: 'Updated Title' }))
      expect(mockNavigate).toHaveBeenCalledWith({ page: 'detail', taskId: 't1' })
    })
  })

  it('navigates back to detail on cancel', async () => {
    const { container } = render(<TaskFormPage taskId="t1" onNavigate={mockNavigate} />)

    await waitFor(() => {
      const titleInput = container.querySelector('input[placeholder="What needs to be done?"]') as HTMLInputElement
      expect(titleInput.value).toBe('Existing Task')
    })

    const cancelBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Cancel')!
    fireEvent.click(cancelBtn)

    expect(mockNavigate).toHaveBeenCalledWith({ page: 'detail', taskId: 't1' })
  })

  it('shows not found for non-existent task', () => {
    const { container } = render(<TaskFormPage taskId="nonexistent" onNavigate={mockNavigate} />)

    expect(container.textContent).toContain('Not found')
    expect(container.textContent).toContain('Task not found')
  })
})
