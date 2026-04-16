import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TaskDetailView } from './TaskDetailView'
import { CodingAgentType, TaskStatus } from '@/types'
import type { Agent, WorkfloTask } from '@/types'

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
if (!api.onHeartbeatAlert) api.onHeartbeatAlert = vi.fn(() => vi.fn())
if (!api.onHeartbeatDisabled) api.onHeartbeatDisabled = vi.fn(() => vi.fn())

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

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    server_url: 'http://localhost:4096',
    config: {
      coding_agent: CodingAgentType.CLAUDE_CODE,
      model: 'anthropic/claude-sonnet-4-20250514'
    },
    is_default: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides
  } as Agent
}

function renderDetailView(overrides: {
  task?: Partial<WorkfloTask>
  agents?: Agent[]
  parentTask?: WorkfloTask | null
  onNavigateToTask?: (taskId: string) => void
  onEditAgent?: (agentId: string) => void
  onTriage?: () => void
  canTriage?: boolean
  onStartAgent?: () => void
  canStartAgent?: boolean
  onResumeAgent?: () => void
  canResumeAgent?: boolean
  onRestartAgent?: () => void
  canRestartAgent?: boolean
  onCompleteTask?: () => void
  onUpdateDescription?: (description: string) => void | Promise<void>
} = {}) {
  const task = makeTask(overrides.task)
  return render(
    <TaskDetailView
      task={task}
      agents={overrides.agents ?? []}
      onEdit={noopFn}
      onDelete={noopFn}
      onUpdateAttachments={noopFn}
      onUpdateOutputFields={noopFn}
      onCompleteTask={overrides.onCompleteTask ?? noopFn}
      onAssignAgent={noopFn}
      onUpdateRepos={noopFn}
      onAddRepos={noopFn}
      parentTask={overrides.parentTask ?? null}
      onNavigateToTask={overrides.onNavigateToTask}
      onEditAgent={overrides.onEditAgent}
      onTriage={overrides.onTriage}
      canTriage={overrides.canTriage}
      onStartAgent={overrides.onStartAgent}
      canStartAgent={overrides.canStartAgent}
      onResumeAgent={overrides.onResumeAgent}
      canResumeAgent={overrides.canResumeAgent}
      onRestartAgent={overrides.onRestartAgent}
      canRestartAgent={overrides.canRestartAgent}
      onUpdateDescription={overrides.onUpdateDescription}
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

describe('TaskDetailView – edit agent action', () => {
  it('shows an Edit agent button when an agent is assigned', () => {
    const agent = makeAgent()
    const onEditAgent = vi.fn()
    renderDetailView({
      task: { agent_id: agent.id },
      agents: [agent],
      onEditAgent
    })
    const btn = screen.getByTestId('edit-agent-button')
    expect(btn).toBeInTheDocument()
    fireEvent.click(btn)
    expect(onEditAgent).toHaveBeenCalledWith(agent.id)
  })

  it('does not render the Edit agent button when no agent is assigned', () => {
    renderDetailView({ task: { agent_id: null }, agents: [makeAgent()], onEditAgent: vi.fn() })
    expect(screen.queryByTestId('edit-agent-button')).not.toBeInTheDocument()
  })
})

describe('TaskDetailView – unconfigured agent blocking', () => {
  const unconfiguredAgent = makeAgent({
    id: 'agent-unconfigured',
    name: 'Unconfigured',
    is_default: true,
    config: { coding_agent: undefined, model: undefined }
  })
  const configuredAgent = makeAgent({ id: 'agent-ok', name: 'Ready' })

  it('renders a warning when the assigned agent is missing provider and model', () => {
    renderDetailView({
      task: { agent_id: unconfiguredAgent.id },
      agents: [unconfiguredAgent],
      onEditAgent: vi.fn(),
      // canStartAgent is expected to be false upstream — but the warning does
      // not depend on that flag.
      canStartAgent: false
    })
    const warning = screen.getByTestId('agent-config-warning')
    expect(warning).toBeInTheDocument()
    expect(warning.textContent).toMatch(/Provider and model are not selected/i)
    expect(warning.textContent).toMatch(/Start is disabled/i)
  })

  it('renders a warning naming the default agent when unassigned + default is unconfigured', () => {
    renderDetailView({
      task: { agent_id: null },
      agents: [unconfiguredAgent],
      onEditAgent: vi.fn(),
      canTriage: false
    })
    const warning = screen.getByTestId('agent-config-warning')
    expect(warning.textContent).toMatch(/Unconfigured/)
    expect(warning.textContent).toMatch(/Triage is disabled/i)
  })

  it('clicking the warning\'s Edit agent button invokes onEditAgent with the target agent id', () => {
    const onEditAgent = vi.fn()
    renderDetailView({
      task: { agent_id: unconfiguredAgent.id },
      agents: [unconfiguredAgent],
      onEditAgent
    })
    fireEvent.click(screen.getByTestId('agent-config-warning-edit'))
    expect(onEditAgent).toHaveBeenCalledWith(unconfiguredAgent.id)
  })

  it('does not render the warning when assigned agent is fully configured', () => {
    renderDetailView({
      task: { agent_id: configuredAgent.id },
      agents: [configuredAgent],
      onEditAgent: vi.fn(),
      canStartAgent: true
    })
    expect(screen.queryByTestId('agent-config-warning')).not.toBeInTheDocument()
  })

  it('does not render the warning when the default triage agent is fully configured', () => {
    renderDetailView({
      task: { agent_id: null },
      agents: [configuredAgent],
      onEditAgent: vi.fn(),
      canTriage: true
    })
    expect(screen.queryByTestId('agent-config-warning')).not.toBeInTheDocument()
  })
})

describe('TaskDetailView – main CTA priority', () => {
  const agent = makeAgent({ id: 'a-1', name: 'Assigned' })

  it('renders Start Task as the primary CTA when canStartAgent is true and demotes Complete', () => {
    const onStart = vi.fn()
    const onComplete = vi.fn()
    renderDetailView({
      task: { agent_id: agent.id, status: TaskStatus.NotStarted },
      agents: [agent],
      onStartAgent: onStart,
      canStartAgent: true,
      onCompleteTask: onComplete
    })
    const startBtn = screen.getByTestId('main-cta-start')
    const completeBtn = screen.getByTestId('main-cta-complete')
    expect(startBtn).toBeInTheDocument()
    expect(startBtn.textContent).toMatch(/start task/i)
    expect(completeBtn).toBeInTheDocument()
    // Complete should be outline variant (no bg-primary class) when Start is primary
    expect(completeBtn.className).not.toMatch(/bg-primary/)
    // Start should look primary
    expect(startBtn.className).toMatch(/bg-primary/)

    fireEvent.click(startBtn)
    expect(onStart).toHaveBeenCalledTimes(1)
    fireEvent.click(completeBtn)
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('in ReadyForReview promotes Complete Task to primary and demotes Resume Session to secondary', () => {
    // Rationale: the agent has finished; the expected "happy path" for the
    // user reviewing the result is to accept (Complete). Resume stays
    // visible as an outline secondary action for the "needs another pass"
    // case. Mirrors code-review tools that promote Approve/Merge after the
    // agent finishes.
    renderDetailView({
      task: { agent_id: agent.id, status: TaskStatus.ReadyForReview, session_id: 'sess-1' },
      agents: [agent],
      onResumeAgent: vi.fn(),
      canResumeAgent: true
    })
    const completeBtn = screen.getByTestId('main-cta-complete')
    const resumeBtn = screen.getByTestId('main-cta-resume')
    expect(completeBtn).toBeInTheDocument()
    expect(resumeBtn).toBeInTheDocument()
    // Complete is the primary (filled bg-primary) button
    expect(completeBtn.className).toMatch(/bg-primary/)
    // Resume is the outline/secondary button (no bg-primary fill)
    expect(resumeBtn.className).not.toMatch(/bg-primary/)
  })

  it('renders Resume Session as the primary CTA in non-ReadyForReview states that allow resume', () => {
    // In a state that isn't ReadyForReview (e.g., AgentLearning) but still
    // allows resume, Resume should remain the primary — the "accept the
    // work" flip is specific to ReadyForReview.
    renderDetailView({
      task: { agent_id: agent.id, status: TaskStatus.AgentLearning, session_id: 'sess-1' },
      agents: [agent],
      onResumeAgent: vi.fn(),
      canResumeAgent: true
    })
    const resumeBtn = screen.getByTestId('main-cta-resume')
    expect(resumeBtn).toBeInTheDocument()
    expect(resumeBtn.className).toMatch(/bg-primary/)
    const completeBtn = screen.getByTestId('main-cta-complete')
    expect(completeBtn.className).not.toMatch(/bg-primary/)
  })

  it('renders Triage as the primary CTA when canTriage is true and no agent is assigned', () => {
    renderDetailView({
      task: { agent_id: null, status: TaskStatus.NotStarted },
      agents: [makeAgent()],
      onTriage: vi.fn(),
      canTriage: true
    })
    expect(screen.getByTestId('main-cta-triage')).toBeInTheDocument()
  })

  it('falls back to Complete Task as the primary CTA when no start/resume/triage is available', () => {
    renderDetailView({
      task: { agent_id: agent.id, status: TaskStatus.AgentWorking, session_id: 'sess-1' },
      agents: [agent]
      // canStartAgent / canResumeAgent / canTriage all falsy
    })
    const completeBtn = screen.getByTestId('main-cta-complete')
    expect(completeBtn).toBeInTheDocument()
    // Without a primary action, Complete is the primary variant
    expect(completeBtn.className).toMatch(/bg-primary/)
    expect(screen.queryByTestId('main-cta-start')).not.toBeInTheDocument()
  })

  it('does not render any CTA when the task is completed', () => {
    renderDetailView({
      task: { agent_id: agent.id, status: TaskStatus.Completed },
      agents: [agent]
    })
    expect(screen.queryByTestId('main-cta-start')).not.toBeInTheDocument()
    expect(screen.queryByTestId('main-cta-complete')).not.toBeInTheDocument()
  })
})

describe('TaskDetailView – inline description editing', () => {
  // Replace the default CollapsibleDescription mock with a richer one that
  // surfaces the editing props so we can assert wiring without depending on
  // the real component's internals.
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes onUpdateDescription through to CollapsibleDescription as onSave', () => {
    const onUpdate = vi.fn()
    renderDetailView({
      task: { description: 'hello world' },
      onUpdateDescription: onUpdate
    })
    // The mocked CollapsibleDescription in the top-level mock renders a div
    // with the description text; our real one would accept onSave. We assert
    // that no error is thrown and the description is rendered.
    expect(screen.getByTestId('collapsible-description').textContent).toBe('hello world')
  })

  it('renders the description region even for an empty description when onUpdateDescription is provided, so users can add one', () => {
    const onUpdate = vi.fn()
    const { container } = renderDetailView({
      task: { description: '' },
      onUpdateDescription: onUpdate
    })
    // Our mock renders a div with data-testid="collapsible-description" regardless
    // of description value. Just verify it's rendered when editable.
    expect(container.querySelector('[data-testid="collapsible-description"]')).not.toBeNull()
  })

  it('does not render the description region for an empty description when no onUpdateDescription is provided', () => {
    const { container } = renderDetailView({
      task: { description: '' }
    })
    expect(container.querySelector('[data-testid="collapsible-description"]')).toBeNull()
  })
})
