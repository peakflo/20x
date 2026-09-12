import { api } from '../api/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { ArtifactType } from '@shared/artifacts'
import { TaskDetailPage } from './TaskDetailPage'
import { useTaskStore, type Task } from '../stores/task-store'
import { useAgentStore } from '../stores/agent-store'
import { useArtifactStore } from '../stores/artifact-store'

const mockNavigate = vi.fn()

// Route a source-backed completion through the server without a network call.
const { completeMock } = vi.hoisted(() => ({
  completeMock: vi.fn(async () => ({ completed: true, status: 'completed' }))
}))
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      tasks: {
        ...actual.api.tasks,
        complete: completeMock
      }
    }
  }
})

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'pf-web: actions migration',
    description: 'Migrate all actions',
    type: 'coding',
    priority: 'medium',
    status: 'not_started',
    assignee: '',
    due_date: null,
    labels: [],
    attachments: [],
    repos: ['peakflo/pf-web'],
    output_fields: [],
    agent_id: null,
    session_id: null,
    external_id: null,
    source_id: null,
    source: 'manual',
    complete_at_source: null,
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
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  cleanup()
  useAgentStore.setState({
    agents: [],
    skills: [],
    sessions: new Map()
  })
  useArtifactStore.setState({ artifactsByTask: new Map(), loadingTaskIds: new Set() })
})

// Unmount after each test, not just before the next one: the completion tests
// leave async store/API continuations in flight, and a still-mounted tree lets
// React schedule render work after vitest tears down the DOM environment
// ("ReferenceError: window is not defined" unhandled error, flaky in CI).
afterEach(() => {
  cleanup()
})

describe('TaskDetailPage', () => {
  it.each([
    ['Submit Feedback', true], ['Submit Feedback', false], ['Skip', true], ['Skip', false]
  ] as const)('%s with source completion %s', async (button, completeAtSource) => {
    const task = makeTask({agent_id: 'agent-1', source_id: 'feedback', source: 'Notion', session_id: 'persisted'})
    const originalUpdate = useTaskStore.getState().updateTask
    const updateTask = vi.fn().mockResolvedValue(true)
    const resume = vi.spyOn(api.sessions, 'resume').mockResolvedValue({sessionId: 'persisted'})
    const send = vi.spyOn(api.sessions, 'send').mockResolvedValue({success: true})
    useTaskStore.setState({tasks: [task], isLoading: false, updateTask})
    try {
      const view = render(<TaskDetailPage taskId="task-1" onNavigate={mockNavigate} />)
      fireEvent.click(view.getByTestId('main-cta-complete'))
      if (!completeAtSource) fireEvent.click(view.getByRole('radio', {name: "I'll do it manually"}))
      fireEvent.click(view.getByRole('button', {name: 'Rate 4'}))
      fireEvent.click(view.getByRole('button', {name: button}))
      if (button === 'Submit Feedback') {
        await waitFor(() => expect(send).toHaveBeenCalledWith('persisted', expect.stringContaining('Review the session and update skills'), task.id, task.agent_id))
        expect(updateTask).toHaveBeenCalledWith(task.id, {status: 'agent_learning', feedback_rating: 4, feedback_comment: null, complete_at_source: completeAtSource})
        expect(completeMock).not.toHaveBeenCalled()
      } else {
        await waitFor(() => expect(completeMock).toHaveBeenCalledWith(task.id, completeAtSource))
        expect(send).not.toHaveBeenCalled()
      }
    } finally {
      cleanup()
      useTaskStore.setState({updateTask: originalUpdate})
      resume.mockRestore()
      send.mockRestore()
    }
  })

  it.each([true, false])('starts learning when the saved session ended, source completion %s', async (completeAtSource) => {
    const task = makeTask({agent_id: 'agent-1', source_id: 'notion', source: 'Notion', session_id: 'ended'})
    const originalUpdate = useTaskStore.getState().updateTask
    const updateTask = vi.fn().mockResolvedValue(true)
    const resume = vi.spyOn(api.sessions, 'resume').mockResolvedValue({sessionId: ''})
    const start = vi.spyOn(api.sessions, 'start').mockResolvedValue({sessionId: 'learning'})
    const send = vi.spyOn(api.sessions, 'send').mockResolvedValue({success: true})
    useTaskStore.setState({tasks: [task], isLoading: false, updateTask})
    try {
      const view = render(<TaskDetailPage taskId="task-1" onNavigate={mockNavigate} />)
      fireEvent.click(view.getByTestId('main-cta-complete'))
      if (!completeAtSource) fireEvent.click(view.getByRole('radio', {name: "I'll do it manually"}))
      fireEvent.click(view.getByRole('button', {name: 'Rate 5'}))
      fireEvent.click(view.getByRole('button', {name: 'Submit Feedback'}))
      await waitFor(() => expect(send).toHaveBeenCalledWith('learning', expect.stringContaining('User rated this session 5/5'), task.id, task.agent_id))
      expect(start).toHaveBeenCalledWith('agent-1', task.id, true)
      expect(updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({status: 'agent_learning', feedback_rating: 5, complete_at_source: completeAtSource}))
      expect(completeMock).not.toHaveBeenCalled()
    } finally {
      cleanup()
      useTaskStore.setState({updateTask: originalUpdate})
      resume.mockRestore()
      start.mockRestore()
      send.mockRestore()
    }
  })

  it.each(['approve', undefined])('shows the Session Feedback action %s before Skip completes', async (action) => {
    const task = makeTask({ agent_id: 'agent-1', source_id: 'session-feedback', source: 'Session Feedback',
      output_fields: action ? [{ id: 'action', value: action }] : [] })
    useTaskStore.setState({ tasks: [task], isLoading: false })
    const view = render(<TaskDetailPage taskId="task-1" onNavigate={mockNavigate} />)
    fireEvent.click(view.getByTestId('main-cta-complete'))
    const dialog = within(view.getByRole('dialog'))
    expect(dialog.getByText(`Action at Session Feedback: ${action || 'complete'}. Completion sends this action and the task outputs to the source.`)).toBeTruthy()
    expect(completeMock).not.toHaveBeenCalled()
    fireEvent.click(dialog.getByRole('button', { name: 'Skip' }))
    await waitFor(() => expect(completeMock).toHaveBeenCalledWith(task.id, true))
  })

  it('cancels source feedback without completing', () => {
    useTaskStore.setState({ tasks: [makeTask({ agent_id: 'agent-1', source_id: 'session-feedback', source: 'Session Feedback' })], isLoading: false })
    const view = render(<TaskDetailPage taskId="task-1" onNavigate={mockNavigate} />)
    fireEvent.click(view.getByTestId('main-cta-complete'))
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }))
    expect(completeMock).not.toHaveBeenCalled()
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('switches to the artifacts segment and opens an artifact viewer', () => {
    const task = makeTask({ id: 'task-1' })
    useTaskStore.setState({ tasks: [task], isLoading: false })
    useArtifactStore.setState({
      artifactsByTask: new Map([['task-1', [{
        id: 'task-1:markdown:report.md',
        taskId: 'task-1',
        type: ArtifactType.MARKDOWN,
        title: 'report.md',
        path: 'report.md',
        updatedAt: 1,
        reloadTrigger: 0
      }]]])
    })

    const { getByRole, getByText } = render(
      <TaskDetailPage taskId="task-1" onNavigate={mockNavigate} />
    )

    fireEvent.click(getByRole('button', { name: /Artifacts \(1\)/ }))
    fireEvent.click(getByText('report.md'))

    expect(mockNavigate).toHaveBeenCalledWith({
      page: 'artifact',
      taskId: 'task-1',
      artifactId: 'task-1:markdown:report.md'
    })
  })

  it('renders without error for a task with subtasks', () => {
    const parentTask = makeTask({ id: 'parent-1', title: 'Parent task' })
    const subtask1 = makeTask({
      id: 'sub-1',
      title: 'Subtask 1',
      parent_task_id: 'parent-1'
    })
    const subtask2 = makeTask({
      id: 'sub-2',
      title: 'Subtask 2',
      parent_task_id: 'parent-1'
    })

    useTaskStore.setState({
      tasks: [parentTask, subtask1, subtask2],
      isLoading: false
    })

    // This would throw "Maximum update depth exceeded" (React error #185)
    // before the fix due to unstable .filter() selector in useTaskStore
    const { container } = render(
      <TaskDetailPage taskId="parent-1" onNavigate={mockNavigate} />
    )

    expect(container.querySelector('h1')?.textContent).toBe('Parent task')
    // Subtasks section should be visible
    expect(container.textContent).toContain('Subtask 1')
    expect(container.textContent).toContain('Subtask 2')
  })

  it('renders without error for a task with a parent task', () => {
    const parentTask = makeTask({ id: 'parent-1', title: 'Parent task' })
    const childTask = makeTask({
      id: 'child-1',
      title: 'Child task',
      parent_task_id: 'parent-1'
    })

    useTaskStore.setState({
      tasks: [parentTask, childTask],
      isLoading: false
    })

    const { container } = render(
      <TaskDetailPage taskId="child-1" onNavigate={mockNavigate} />
    )

    expect(container.querySelector('h1')?.textContent).toBe('Child task')
    // Parent breadcrumb should be visible
    expect(container.textContent).toContain('Parent task')
  })

  it('renders not found when task does not exist', () => {
    useTaskStore.setState({ tasks: [], isLoading: false })

    const { container } = render(
      <TaskDetailPage taskId="nonexistent" onNavigate={mockNavigate} />
    )

    expect(container.textContent).toContain('Task not found')
  })

  it('renders subtasks sorted by sort_order then created_at', () => {
    const parentTask = makeTask({ id: 'parent-1', title: 'Parent task' })
    const subtaskC = makeTask({
      id: 'sub-c',
      title: 'Subtask C',
      parent_task_id: 'parent-1',
      sort_order: 2,
      created_at: '2026-01-01T00:00:00.000Z'
    })
    const subtaskA = makeTask({
      id: 'sub-a',
      title: 'Subtask A',
      parent_task_id: 'parent-1',
      sort_order: 0,
      created_at: '2026-01-03T00:00:00.000Z'
    })
    const subtaskB = makeTask({
      id: 'sub-b',
      title: 'Subtask B',
      parent_task_id: 'parent-1',
      sort_order: 1,
      created_at: '2026-01-02T00:00:00.000Z'
    })

    // Store order deliberately differs from sort_order
    useTaskStore.setState({
      tasks: [parentTask, subtaskC, subtaskA, subtaskB],
      isLoading: false
    })

    const { container } = render(
      <TaskDetailPage taskId="parent-1" onNavigate={mockNavigate} />
    )

    // Find all subtask title elements inside the subtasks section's divide-y container
    const subtaskSection = container.querySelector('[class*="divide-y"]')
    const titles = subtaskSection
      ? Array.from(subtaskSection.querySelectorAll('[class*="truncate"]')).map(el => el.textContent)
      : []

    // Should be sorted by sort_order: A(0), B(1), C(2)
    expect(titles).toEqual(['Subtask A', 'Subtask B', 'Subtask C'])
  })

  it('sorts subtasks by created_at when sort_order is equal', () => {
    const parentTask = makeTask({ id: 'parent-1', title: 'Parent task' })
    const subtaskLater = makeTask({
      id: 'sub-later',
      title: 'Later Subtask',
      parent_task_id: 'parent-1',
      sort_order: 0,
      created_at: '2026-01-05T00:00:00.000Z'
    })
    const subtaskEarlier = makeTask({
      id: 'sub-earlier',
      title: 'Earlier Subtask',
      parent_task_id: 'parent-1',
      sort_order: 0,
      created_at: '2026-01-01T00:00:00.000Z'
    })

    useTaskStore.setState({
      tasks: [parentTask, subtaskLater, subtaskEarlier],
      isLoading: false
    })

    const { container } = render(
      <TaskDetailPage taskId="parent-1" onNavigate={mockNavigate} />
    )

    const subtaskSection = container.querySelector('[class*="divide-y"]')
    const titles = subtaskSection
      ? Array.from(subtaskSection.querySelectorAll('[class*="truncate"]')).map(el => el.textContent)
      : []

    // Same sort_order → older first
    expect(titles).toEqual(['Earlier Subtask', 'Later Subtask'])
  })

  it('blocks Start and shows a config warning when the assigned agent has no provider/model', () => {
    const unconfiguredAgent = {
      id: 'agent-1',
      name: 'Test Agent',
      server_url: 'http://local:4096',
      config: {} as Record<string, unknown>,
      is_default: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z'
    }
    useAgentStore.setState({ agents: [unconfiguredAgent] })
    const task = makeTask({ agent_id: 'agent-1' })
    useTaskStore.setState({ tasks: [task], isLoading: false })

    const { container } = render(<TaskDetailPage taskId="task-1" onNavigate={mockNavigate} />)

    // Warning is visible
    expect(container.querySelector('[data-testid="agent-config-warning"]')).toBeTruthy()
    // Start button (exact label) must not render
    const startButton = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Start')
    expect(startButton).toBeUndefined()
  })

  it('blocks Triage and shows a config warning naming the default agent when unconfigured', () => {
    const unconfiguredDefault = {
      id: 'agent-default',
      name: 'Default Agent',
      server_url: 'http://local:4096',
      config: { coding_agent: 'claude_code' } as Record<string, unknown>, // missing model
      is_default: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z'
    }
    useAgentStore.setState({ agents: [unconfiguredDefault] })
    const task = makeTask({ agent_id: null })
    useTaskStore.setState({ tasks: [task], isLoading: false })

    const { container } = render(<TaskDetailPage taskId="task-1" onNavigate={mockNavigate} />)

    const warning = container.querySelector('[data-testid="agent-config-warning"]')
    expect(warning).toBeTruthy()
    expect(warning?.textContent).toMatch(/Default Agent/)
    expect(warning?.textContent).toMatch(/Triage is disabled/i)
    // Triage button (with exact "Triage" label) must not be present
    const triageButton = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Triage')
    expect(triageButton).toBeUndefined()
  })

  it('does not show a config warning when the assigned agent is fully configured', () => {
    const configuredAgent = {
      id: 'agent-ok',
      name: 'Ready',
      server_url: 'http://local:4096',
      config: { coding_agent: 'claude_code', model: 'anthropic/claude-sonnet-4' } as Record<string, unknown>,
      is_default: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z'
    }
    useAgentStore.setState({ agents: [configuredAgent] })
    const task = makeTask({ agent_id: 'agent-ok' })
    useTaskStore.setState({ tasks: [task], isLoading: false })

    const { container } = render(<TaskDetailPage taskId="task-1" onNavigate={mockNavigate} />)
    expect(container.querySelector('[data-testid="agent-config-warning"]')).toBeFalsy()
  })

  it('does not crash when task store updates with new object references', () => {
    // Simulates what happens when fetchTasks polling replaces task objects
    const task = makeTask({ id: 'task-1', title: 'Test task' })
    const subtask = makeTask({
      id: 'sub-1',
      title: 'Subtask',
      parent_task_id: 'task-1'
    })

    useTaskStore.setState({ tasks: [task, subtask], isLoading: false })

    const { container, unmount } = render(
      <TaskDetailPage taskId="task-1" onNavigate={mockNavigate} />
    )

    // Simulate store update with new object references (like fetchTasks does)
    const freshTask = { ...task }
    const freshSubtask = { ...subtask }
    useTaskStore.setState({ tasks: [freshTask, freshSubtask], isLoading: false })

    // Should still render correctly without infinite loop
    expect(container.querySelector('h1')?.textContent).toBe('Test task')
    expect(container.textContent).toContain('Subtask')

    unmount()
  })

  it.each([null, 'src-1'])('asks before completing source %s', (sourceId) => {
    completeMock.mockClear()
    const task = makeTask({ source_id: sourceId, complete_at_source: false })
    useTaskStore.setState({ tasks: [task], isLoading: false })
    const { getByTestId, getByRole, queryByText } = render(<TaskDetailPage taskId="task-1" onNavigate={mockNavigate} />)
    fireEvent.click(getByTestId('main-cta-complete'))
    if (sourceId) {
      expect(completeMock).not.toHaveBeenCalled()
      fireEvent.click(getByRole('radio', { name: "I'll do it manually" }))
      fireEvent.click(getByRole('button', { name: 'Complete' }))
      expect(completeMock).toHaveBeenCalledWith('task-1', false)
    } else {
      expect(completeMock).toHaveBeenCalledWith('task-1', true)
      expect(queryByText("I'll do it manually")).toBeNull()
    }
  })
})
