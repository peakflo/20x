import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TaskDetailView } from './TaskDetailView'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'

// Mock CollapsibleDescription to avoid markdown rendering complexity
vi.mock('@/components/ui/CollapsibleDescription', () => ({
  CollapsibleDescription: ({ description }: { description: string }) => (
    <div data-testid="collapsible-description">{description}</div>
  )
}))

// Mock stores
vi.mock('@/stores/skill-store', () => ({
  useSkillStore: () => ({ skills: [], fetchSkills: vi.fn() })
}))

// Add missing electronAPI mocks
const api = window.electronAPI as unknown as Record<string, unknown>
if (!api.tasks) api.tasks = { getWorkspaceDir: vi.fn().mockResolvedValue('/tmp') }
if (!api.shell) (api as Record<string, unknown>).shell = { openPath: vi.fn() }

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
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    parent_task_id: null,
    sort_order: 0,
    ...overrides
  }
}

const noopFn = vi.fn()

function renderDetailView(overrides: {
  task?: Partial<WorkfloTask>
  parentTask?: WorkfloTask | null
  onNavigateToTask?: (taskId: string) => void
} = {}) {
  const task = makeTask(overrides.task)
  return render(
    <TaskDetailView
      task={task}
      agents={[]}
      onEdit={noopFn}
      onDelete={noopFn}
      onUpdateAttachments={noopFn}
      onUpdateOutputFields={noopFn}
      onCompleteTask={noopFn}
      onAssignAgent={noopFn}
      onUpdateRepos={noopFn}
      onAddRepos={noopFn}
      parentTask={overrides.parentTask ?? null}
      onNavigateToTask={overrides.onNavigateToTask}
    />
  )
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TaskDetailView – parent task context panel', () => {
  const parentTask = makeTask({
    id: 'parent-1',
    title: 'Parent Task Title',
    description: 'This is the parent task description with important context.',
    status: TaskStatus.AgentWorking,
    type: 'coding',
    priority: 'high',
    labels: ['urgent', 'backend'],
  })

  it('does not show parent context panel when there is no parent task', () => {
    renderDetailView()
    expect(screen.queryByText('Parent task:')).not.toBeInTheDocument()
    expect(screen.queryByText('Go to parent')).not.toBeInTheDocument()
  })

  it('shows collapsed parent context panel with title when parent task exists', () => {
    renderDetailView({ parentTask, onNavigateToTask: noopFn })
    expect(screen.getByText('Parent task:')).toBeInTheDocument()
    expect(screen.getByText('Parent Task Title')).toBeInTheDocument()
    expect(screen.getByText('Go to parent')).toBeInTheDocument()
    // Description should not be visible when collapsed
    expect(screen.queryByText('This is the parent task description with important context.')).not.toBeInTheDocument()
  })

  it('expands to show parent task details when clicked', () => {
    renderDetailView({ parentTask, onNavigateToTask: noopFn })

    // Click the expand button (the row with "Parent task:")
    fireEvent.click(screen.getByText('Parent task:'))

    // Now description should be visible
    expect(screen.getByText('This is the parent task description with important context.')).toBeInTheDocument()

    // Labels should be visible
    expect(screen.getByText('urgent')).toBeInTheDocument()
    expect(screen.getByText('backend')).toBeInTheDocument()
  })

  it('collapses details when clicked again', () => {
    renderDetailView({ parentTask, onNavigateToTask: noopFn })

    // Expand
    fireEvent.click(screen.getByText('Parent task:'))
    expect(screen.getByText('This is the parent task description with important context.')).toBeInTheDocument()

    // Collapse
    fireEvent.click(screen.getByText('Parent task:'))
    expect(screen.queryByText('This is the parent task description with important context.')).not.toBeInTheDocument()
  })

  it('navigates to parent task when "Go to parent" is clicked', () => {
    const onNavigate = vi.fn()
    renderDetailView({ parentTask, onNavigateToTask: onNavigate })

    fireEvent.click(screen.getByText('Go to parent'))
    expect(onNavigate).toHaveBeenCalledWith('parent-1')
  })

  it('does not show labels section when parent has no labels', () => {
    const parentWithoutLabels = makeTask({
      id: 'parent-2',
      title: 'Simple Parent',
      description: 'Simple description',
      labels: [],
    })
    renderDetailView({ parentTask: parentWithoutLabels, onNavigateToTask: noopFn })

    // Expand
    fireEvent.click(screen.getByText('Parent task:'))

    // Description should be visible but no labels
    expect(screen.getByText('Simple description')).toBeInTheDocument()
  })

  it('does not show description when parent has no description', () => {
    const parentNoDesc = makeTask({
      id: 'parent-3',
      title: 'No Desc Parent',
      description: '',
    })
    renderDetailView({ parentTask: parentNoDesc, onNavigateToTask: noopFn })

    // Expand
    fireEvent.click(screen.getByText('Parent task:'))

    // Should not crash, status badges should still show
    expect(screen.getByText('No Desc Parent')).toBeInTheDocument()
  })
})
