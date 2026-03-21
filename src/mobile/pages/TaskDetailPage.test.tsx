import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { TaskDetailPage } from './TaskDetailPage'
import { useTaskStore, type Task } from '../stores/task-store'
import { useAgentStore } from '../stores/agent-store'

const mockNavigate = vi.fn()

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
})

describe('TaskDetailPage', () => {
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

    // Find all subtask buttons (inside the subtasks section's divide-y container)
    const subtaskButtons = container.querySelectorAll('[class*="active:bg-accent"]')
    const titles = Array.from(subtaskButtons).map(el => el.querySelector('[class*="truncate"]')?.textContent)

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

    const subtaskButtons = container.querySelectorAll('[class*="active:bg-accent"]')
    const titles = Array.from(subtaskButtons).map(el => el.querySelector('[class*="truncate"]')?.textContent)

    // Same sort_order → older first
    expect(titles).toEqual(['Earlier Subtask', 'Later Subtask'])
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
})
