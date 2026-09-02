import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, fireEvent, screen, waitFor, cleanup } from '@testing-library/react'
import { clampTranscriptWidth, TaskWorkspace } from './TaskWorkspace'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useArtifactStore } from '@/stores/artifact-store'
import { TaskStatus } from '@/types'
import type { WorkfloTask, Agent } from '@/types'
import { dispatchTaskShortcut, TaskShortcutAction } from '@/lib/keyboard-shortcuts'
import { PinnedArtifactTabId } from '@/stores/artifact-store'

vi.mock('@/components/agents/AgentTranscriptPanel', () => ({
  AgentTranscriptPanel: ({ onSend }: { onSend?: (message: string) => void }) => (
    <button data-testid="mock-send" onClick={() => onSend?.('approved')}>send</button>
  )
}))

vi.mock('@/components/github/RepoSelectorDialog', () => ({
  RepoSelectorDialog: ({ open, onConfirm }: { open: boolean; onConfirm: (repos: Array<{ fullName: string; defaultBranch: string }>, org: string, provider: 'github' | 'gitlab') => void }) => (
    open
      ? <button data-testid="mock-confirm-repo" onClick={() => onConfirm([{ fullName: 'peakflo/api', defaultBranch: 'main' }], 'peakflo', 'github')}>confirm repo</button>
      : null
  )
}))

// Add missing electronAPI mocks that child components need
const api = window.electronAPI as unknown as Record<string, unknown>
if (!api.onGithubDeviceCode) api.onGithubDeviceCode = vi.fn(() => vi.fn())
if (!api.onHeartbeatAlert) api.onHeartbeatAlert = vi.fn(() => vi.fn())
if (!api.onHeartbeatDisabled) api.onHeartbeatDisabled = vi.fn(() => vi.fn())
if (!api.tasks) api.tasks = { getWorkspaceDir: vi.fn().mockResolvedValue('/tmp') }
if (!api.artifacts) api.artifacts = { scan: vi.fn().mockResolvedValue([]), read: vi.fn().mockResolvedValue(null) }

// Minimal task factory
function makeRendererTask(overrides: Partial<WorkfloTask> = {}): WorkfloTask {
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
    agent_id: 'agent-1',
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
    parent_task_id: null,
    sort_order: 0,
    ...overrides
  }
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    server_url: 'http://localhost:4096',
    config: {},
    is_default: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides
  } as Agent
}

const noopFn = vi.fn()
const noopAsync = vi.fn().mockResolvedValue(undefined)

function renderWorkspace(task: WorkfloTask, agents: Agent[] = [makeAgent()]) {
  return render(
    <TaskWorkspace
      task={task}
      agents={agents}
      onEdit={noopFn}
      onDelete={noopFn}
      onUpdateAttachments={noopFn}
      onUpdateOutputFields={noopFn}
      onCompleteTask={noopFn}
      onAssignAgent={noopFn}
      onUpdateTask={noopAsync}
    />
  )
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  useAgentStore.setState({
    agents: [],
    isLoading: false,
    error: null,
    sessions: new Map()
  })
  useSettingsStore.setState({
    githubOrg: 'peakflo',
    ghCliStatus: null,
    glabCliStatus: null,
    gitProvider: 'github',
    isLoading: false
  })
  useArtifactStore.getState().resetTask('task-1')
  vi.clearAllMocks()
  ;(window.electronAPI.settings.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
    github_org: 'peakflo',
    git_provider: 'github'
  })
})

describe('clampTranscriptWidth', () => {
  it('keeps both split panes visible when a persisted width exceeds the container', () => {
    expect(clampTranscriptWidth(1_200, 900)).toBe(576)
    expect(clampTranscriptWidth(100, 900)).toBe(320)
  })
})

describe('TaskWorkspace keyboard actions', () => {
  it('opens the snooze dialog for the selected task', () => {
    renderWorkspace(makeRendererTask())
    act(() => dispatchTaskShortcut({ action: TaskShortcutAction.SNOOZE, taskId: 'task-1' }))
    expect(screen.getByText('Snooze Task')).toBeInTheDocument()
  })

  it('opens the requested task panel', () => {
    renderWorkspace(makeRendererTask())
    act(() => dispatchTaskShortcut({ action: TaskShortcutAction.OPEN_DETAILS, taskId: 'task-1' }))
    expect(useArtifactStore.getState().getUI('task-1').activeTabId).toBe(PinnedArtifactTabId.DETAILS)
  })
})

describe('TaskWorkspace – artifacts/details sidebar default width', () => {
  // Keys older than the current one must all be ignored as stale.
  const STALE_KEYS = [
    '20x:task:transcriptWidth', // v1: pre-redesign widths
    '20x:task:transcriptWidth:v2' // v2: poisoned by scaled-canvas drags
  ]
  const V3_KEY = '20x:task:transcriptWidth:v3'

  let layoutWidth: number
  let screenScale: number

  beforeEach(() => {
    STALE_KEYS.forEach((key) => window.localStorage.removeItem(key))
    window.localStorage.removeItem(V3_KEY)
    // jsdom reports zero-sized rects and offsetWidth 0; give the workspace
    // body a deterministic layout width, optionally scaled by a canvas-style
    // ancestor transform: offsetWidth is LAYOUT px, getBoundingClientRect()
    // is SCREEN px (scaled) — exactly how canvas task panels behave.
    // offsetWidth lives on Element.prototype in jsdom, so shadow it directly
    // on HTMLDivElement.prototype rather than spyOn.
    layoutWidth = 1_000
    screenScale = 1
    Object.defineProperty(HTMLDivElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => layoutWidth
    })
    vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      width: layoutWidth * screenScale, height: 800, top: 0, left: 0,
      bottom: 800, right: layoutWidth * screenScale, x: 0, y: 0,
      toJSON: () => ({})
    } as DOMRect))
    // jsdom may throw "no active pointer" on pointer capture; the drag tests
    // only need the pointermove/pointerup handlers to fire. Define the stubs
    // (rather than spyOn) since this jsdom build may not implement them.
    for (const capture of ['setPointerCapture', 'releasePointerCapture'] as const) {
      Object.defineProperty(HTMLDivElement.prototype, capture, {
        configurable: true,
        writable: true,
        value: vi.fn()
      })
    }
  })

  afterEach(() => {
    delete (HTMLDivElement.prototype as unknown as Record<string, unknown>).offsetWidth
    for (const capture of ['setPointerCapture', 'releasePointerCapture'] as const) {
      delete (HTMLDivElement.prototype as unknown as Record<string, unknown>)[capture]
    }
    vi.restoreAllMocks()
  })

  const renderWorkingTask = () => {
    const task = makeRendererTask({
      status: TaskStatus.AgentWorking,
      session_id: 'persisted-session-1'
    })
    renderWorkspace(task)
  }

  const openDetailsPanel = () => {
    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[0])
  }

  it('gives the artifacts/details sidebar ~40% of the workspace by default', () => {
    renderWorkingTask()
    openDetailsPanel()

    // 60% of the 1000px workspace body goes to the transcript; the remaining
    // ~396px (minus the resizer) is the artifacts/details sidebar.
    expect(screen.getByTestId('transcript-pane').style.width).toBe('600px')
  })

  it('ignores stale widths persisted under legacy storage keys', () => {
    STALE_KEYS.forEach((key) => window.localStorage.setItem(key, '340'))
    renderWorkingTask()
    openDetailsPanel()

    expect(screen.getByTestId('transcript-pane').style.width).toBe('600px')
  })

  it('respects a user-dragged width persisted under the current key', () => {
    window.localStorage.setItem(V3_KEY, '340')
    renderWorkingTask()
    openDetailsPanel()

    expect(screen.getByTestId('transcript-pane').style.width).toBe('340px')
  })

  it('does not persist system clamps back to storage as user preferences', () => {
    // Width far beyond the 1000px container must be clamped on screen...
    window.localStorage.setItem(V3_KEY, '1200')
    renderWorkingTask()
    openDetailsPanel()

    expect(screen.getByTestId('transcript-pane').style.width).toBe('676px')
    // ...but the stored preference keeps its original value.
    expect(window.localStorage.getItem(V3_KEY)).toBe('1200')
  })

  it('computes the default split in layout px inside scaled canvas panels', () => {
    // Canvas task panels render under scale(zoom): rect measurements come
    // back scaled while width styles apply in local px. A 1020px panel at
    // zoom 0.5 must default to 60% of its LOCAL width (612px), not collapse
    // to the 320px floor and leave the sidebar at ~70%.
    layoutWidth = 1_020
    screenScale = 0.5
    renderWorkingTask()
    openDetailsPanel()

    expect(screen.getByTestId('transcript-pane').style.width).toBe('612px')
  })

  it('converts drag positions to layout px so the sidebar can shrink in scaled panels', () => {
    layoutWidth = 1_020
    screenScale = 0.5
    renderWorkingTask()
    openDetailsPanel()

    const resizer = screen.getByRole('separator', { name: 'Resize transcript' })
    fireEvent.pointerDown(resizer, { pointerId: 1, clientX: 300 })
    // Pointer at screen x=400 → local x=800 (scale 0.5) → clamped to 696.
    // The sidebar can now go down to ~31% instead of being stuck at ~70%.
    fireEvent.pointerMove(resizer, { pointerId: 1, clientX: 400 })
    fireEvent.pointerUp(resizer, { pointerId: 1 })

    expect(screen.getByTestId('transcript-pane').style.width).toBe('696px')
    // The drag persists a LOCAL px value under the current key.
    expect(window.localStorage.getItem(V3_KEY)).toBe('696')
  })
})

describe('TaskWorkspace – stale triage session cleanup', () => {
  it('sets up worktrees when adding repos to a task with only a persisted session_id', async () => {
    ;(window.electronAPI.github.checkCli as ReturnType<typeof vi.fn>).mockResolvedValue({ installed: true, authenticated: true })
    ;(window.electronAPI.gitlab.checkCli as ReturnType<typeof vi.fn>).mockResolvedValue({ installed: false, authenticated: false })

    const task = makeRendererTask({
      repos: ['peakflo/20x'],
      status: TaskStatus.AgentWorking,
      session_id: 'persisted-session-1'
    })

    renderWorkspace(task)

    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[0])
    // Use exact-match regex — loose /add/i would also match the
    // CollapsibleDescription's "Add description..." inline-edit placeholder.
    fireEvent.click(screen.getAllByRole('button', { name: /^add$/i })[0])
    fireEvent.click(await screen.findByTestId('mock-confirm-repo'))

    await waitFor(() => {
      expect(window.electronAPI.worktree.setup).toHaveBeenCalledWith(
        task.id,
        [{ fullName: 'peakflo/api', defaultBranch: 'main' }],
        'peakflo',
        'github'
      )
    })
  })

  it('removes stale triage session on mount when task is no longer triaging', () => {
    // Simulate a leftover triage session: sessionId set, idle, has messages, but task
    // has already transitioned to NotStarted and has no persisted session_id.
    const taskId = 'task-1'
    useAgentStore.getState().initSession(taskId, 'triage-session-123', 'agent-1')
    // Manually set status to idle and add a message (simulating triage completion while unmounted)
    useAgentStore.setState((state) => {
      const session = state.sessions.get(taskId)!
      const updated = {
        ...session,
        status: SessionStatus.IDLE,
        messages: [
          {
            id: 'msg-1',
            role: 'assistant' as const,
            content: 'Triage complete',
            timestamp: new Date()
          }
        ]
      }
      return { sessions: new Map(state.sessions).set(taskId, updated) }
    })

    // Sanity: session exists before render
    expect(useAgentStore.getState().sessions.has(taskId)).toBe(true)

    const task = makeRendererTask({
      id: taskId,
      status: TaskStatus.NotStarted,
      agent_id: 'agent-1',
      session_id: null // triage never persists session_id
    })

    act(() => {
      renderWorkspace(task)
    })

    // The stale session should have been removed on mount
    expect(useAgentStore.getState().sessions.has(taskId)).toBe(false)
  })

  it('does NOT remove session when task is still triaging', () => {
    const taskId = 'task-1'
    useAgentStore.getState().initSession(taskId, 'triage-session-123', 'agent-1')

    // Session is working (triage still in progress)
    expect(useAgentStore.getState().sessions.has(taskId)).toBe(true)

    const task = makeRendererTask({
      id: taskId,
      status: TaskStatus.Triaging,
      agent_id: null,
      session_id: null
    })

    act(() => {
      renderWorkspace(task)
    })

    // Session should still be present — triage is still running
    expect(useAgentStore.getState().sessions.has(taskId)).toBe(true)
  })

  it('does NOT remove session when task has a persisted session_id (coding session)', () => {
    const taskId = 'task-1'
    useAgentStore.getState().initSession(taskId, 'coding-session-456', 'agent-1')
    // Set to idle with messages (completed coding session transcript)
    useAgentStore.setState((state) => {
      const session = state.sessions.get(taskId)!
      const updated = {
        ...session,
        status: SessionStatus.IDLE,
        messages: [
          {
            id: 'msg-1',
            role: 'assistant' as const,
            content: 'Coding done',
            timestamp: new Date()
          }
        ]
      }
      return { sessions: new Map(state.sessions).set(taskId, updated) }
    })

    const task = makeRendererTask({
      id: taskId,
      status: TaskStatus.NotStarted,
      agent_id: 'agent-1',
      session_id: 'coding-session-456' // persisted — this is a real coding session
    })

    act(() => {
      renderWorkspace(task)
    })

    // Session should still be present — it's a legitimate coding session, not stale triage
    expect(useAgentStore.getState().sessions.has(taskId)).toBe(true)
  })

  it('routes unresolved question replies to approve even when status is not waiting approval', async () => {
    const taskId = 'task-1'
    const agentId = 'agent-1'

    useAgentStore.getState().initSession(taskId, 'session-1', agentId)
    useAgentStore.setState((state) => {
      const session = state.sessions.get(taskId)!
      return {
        sessions: new Map(state.sessions).set(taskId, {
          ...session,
          status: SessionStatus.IDLE,
          messages: [
            {
              id: 'question-1',
              role: 'assistant' as const,
              content: 'Need approval',
              timestamp: new Date(),
              partType: 'question',
              tool: {
                name: 'permission',
                status: 'pending',
                requestId: 'pi-request-1',
                questions: [
                  {
                    header: 'Permission',
                    question: 'Allow write?',
                    options: [{ label: 'Yes', description: 'Allow once' }]
                  }
                ]
              }
            }
          ]
        })
      }
    })

    const task = makeRendererTask({ id: taskId, status: TaskStatus.AgentWorking, session_id: 'session-1' })
    renderWorkspace(task)

    fireEvent.click(screen.getByTestId('mock-send'))
    fireEvent.click(screen.getByTestId('mock-send'))

    await waitFor(() => {
      expect(window.electronAPI.agentSession.approve).toHaveBeenCalledWith(
        'session-1',
        true,
        'approved',
        'permission',
        'pi-request-1'
      )
    })
    expect(window.electronAPI.agentSession.approve).toHaveBeenCalledTimes(1)
    expect(window.electronAPI.agentSession.send).not.toHaveBeenCalled()
  })

  it('resumes a lost session before it answers a persisted Pi question', async () => {
    const taskId = 'task-1'
    const agentId = 'agent-1'
    useAgentStore.setState({
      sessions: new Map([[taskId, {
        sessionId: null,
        agentId,
        taskId,
        status: SessionStatus.IDLE,
        messages: [{
          id: 'pi-question-request-3',
          role: 'assistant',
          content: 'Choose an environment',
          timestamp: new Date(),
          partType: 'question',
          tool: {
            name: 'question',
            status: 'running',
            requestId: 'request-3',
            questions: [{
              header: 'Environment',
              question: 'Choose an environment',
              options: [{ label: 'Stage', description: 'Stage' }]
            }]
          }
        }],
        pendingApproval: null
      }]])
    })
    vi.mocked(window.electronAPI.agentSession.resume).mockResolvedValue({ sessionId: 'resumed-session-3' })
    const task = makeRendererTask({
      id: taskId,
      status: TaskStatus.AgentWorking,
      agent_id: agentId,
      session_id: 'persisted-session-3'
    })

    renderWorkspace(task)
    fireEvent.click(screen.getByTestId('mock-send'))

    await waitFor(() => {
      expect(window.electronAPI.agentSession.resume).toHaveBeenCalledWith(agentId, taskId, 'persisted-session-3')
      expect(window.electronAPI.agentSession.approve).toHaveBeenCalledWith(
        'resumed-session-3',
        true,
        'approved',
        'question',
        'request-3'
      )
    })
  })

  it('resumes a persisted session before sending a follow-up message', async () => {
    const taskId = 'task-1'
    const agentId = 'agent-1'

    useAgentStore.setState({
      sessions: new Map([
        [taskId, {
          sessionId: null,
          agentId,
          taskId,
          status: SessionStatus.IDLE,
          messages: [
            {
              id: 'msg-1',
              role: 'assistant',
              content: 'Previous transcript',
              timestamp: new Date()
            }
          ],
          pendingApproval: null
        }]
      ])
    })

    vi.mocked(window.electronAPI.agentSession.resume).mockResolvedValue({ sessionId: 'resumed-session-1' })

    const task = makeRendererTask({
      id: taskId,
      status: TaskStatus.ReadyForReview,
      agent_id: agentId,
      session_id: 'persisted-session-1'
    })

    renderWorkspace(task)

    fireEvent.click(screen.getByTestId('mock-send'))

    await waitFor(() => {
      expect(window.electronAPI.agentSession.resume).toHaveBeenCalledWith(agentId, taskId, 'persisted-session-1')
    })

    await waitFor(() => {
      expect(window.electronAPI.agentSession.send).toHaveBeenCalledWith('resumed-session-1', 'approved', taskId, agentId, undefined)
    })
  })
})
