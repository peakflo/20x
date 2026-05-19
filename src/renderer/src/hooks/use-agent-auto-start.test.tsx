import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAgentAutoStart } from './use-agent-auto-start'
import { useAgentSchedulerStore } from '@/stores/agent-scheduler-store'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { TaskStatus } from '@/types'
import type { Agent, WorkfloTask } from '@/types'
import type { Mock } from 'vitest'

const mockElectronAPI = window.electronAPI

function getLatestAgentStatusCallback(): ((event: { sessionId: string; agentId: string; taskId: string; status: SessionStatus }) => void) | undefined {
  const calls = (mockElectronAPI.onAgentStatus as unknown as Mock).mock.calls
  const latest = calls[calls.length - 1]
  return latest?.[0]
}

function makeTask(overrides: Partial<WorkfloTask> = {}): WorkfloTask {
  return {
    id: 'task-1',
    title: 'Task',
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
    parent_task_id: null,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides
  }
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Agent 1',
    server_url: 'http://localhost:4096',
    config: {},
    is_default: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides
  }
}

describe('useAgentAutoStart', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()

    useAgentStore.setState({
      agents: [],
      isLoading: false,
      error: null,
      sessions: new Map()
    })

    useAgentSchedulerStore.setState({
      isEnabled: true,
      runningSessionsPerAgent: new Map(),
      queuedTasksPerAgent: new Map()
    })

    ;(mockElectronAPI.db.updateTask as unknown as Mock).mockResolvedValue({})
    ;(mockElectronAPI.db.getTask as unknown as Mock).mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('sets status to triaging before starting triage session', async () => {
    const task = makeTask()
    const triageAgent = makeAgent({ id: 'agent-triage', is_default: true })

    renderHook(() =>
      useAgentAutoStart({
        tasks: [task],
        agents: [triageAgent],
        sessions: new Map(),
        showToast: vi.fn()
      })
    )

    await act(async () => {
      vi.advanceTimersByTime(350)
      await Promise.resolve()
    })

    expect(mockElectronAPI.db.updateTask).toHaveBeenCalledWith(task.id, { status: TaskStatus.Triaging })
    expect(mockElectronAPI.agentSession.start).toHaveBeenCalledWith(triageAgent.id, task.id, undefined, undefined)

    const updateCallOrder = (mockElectronAPI.db.updateTask as unknown as Mock).mock.invocationCallOrder[0]
    const startCallOrder = (mockElectronAPI.agentSession.start as unknown as Mock).mock.invocationCallOrder[0]
    expect(updateCallOrder).toBeLessThan(startCallOrder)
  })

  it('does not triage recurring parent template tasks', async () => {
    const templateTask = makeTask({
      id: 'template-1',
      title: 'Daily standup template',
      is_recurring: true,
      recurrence_parent_id: null,
      recurrence_pattern: '0 9 * * 1-5'
    })
    const triageAgent = makeAgent({ id: 'agent-triage', is_default: true })

    renderHook(() =>
      useAgentAutoStart({
        tasks: [templateTask],
        agents: [triageAgent],
        sessions: new Map(),
        showToast: vi.fn()
      })
    )

    await act(async () => {
      vi.advanceTimersByTime(350)
      await Promise.resolve()
    })

    // Should NOT update status or start a session for the template
    expect(mockElectronAPI.db.updateTask).not.toHaveBeenCalled()
    expect(mockElectronAPI.agentSession.start).not.toHaveBeenCalled()
  })

  it('does not auto-start recurring parent template tasks with assigned agent', async () => {
    const templateTask = makeTask({
      id: 'template-2',
      title: 'Weekly report template',
      is_recurring: true,
      recurrence_parent_id: null,
      recurrence_pattern: '0 10 * * 1',
      agent_id: 'agent-1',
      status: TaskStatus.NotStarted
    })
    const agent = makeAgent({ id: 'agent-1', is_default: false })

    renderHook(() =>
      useAgentAutoStart({
        tasks: [templateTask],
        agents: [agent],
        sessions: new Map(),
        showToast: vi.fn()
      })
    )

    await act(async () => {
      vi.advanceTimersByTime(350)
      await Promise.resolve()
    })

    // Should NOT start a session for the template
    expect(mockElectronAPI.agentSession.start).not.toHaveBeenCalled()
  })

  it('still triages recurring instances (tasks with recurrence_parent_id)', async () => {
    const instanceTask = makeTask({
      id: 'instance-1',
      title: 'Daily standup - 2026-04-09',
      is_recurring: false,
      recurrence_parent_id: 'template-1'
    })
    const triageAgent = makeAgent({ id: 'agent-triage', is_default: true })

    renderHook(() =>
      useAgentAutoStart({
        tasks: [instanceTask],
        agents: [triageAgent],
        sessions: new Map(),
        showToast: vi.fn()
      })
    )

    await act(async () => {
      vi.advanceTimersByTime(350)
      await Promise.resolve()
    })

    // Should triage the instance normally
    expect(mockElectronAPI.db.updateTask).toHaveBeenCalledWith(instanceTask.id, { status: TaskStatus.Triaging })
    expect(mockElectronAPI.agentSession.start).toHaveBeenCalledWith(triageAgent.id, instanceTask.id, undefined, undefined)
  })

  it('starts assigned agent immediately after successful triage completion', async () => {
    const task = makeTask({ id: 'task-2', title: 'Needs triage' })
    const triageAgent = makeAgent({ id: 'agent-triage', is_default: true, name: 'Triage Agent' })
    const assignedAgent = makeAgent({ id: 'agent-assigned', is_default: false, name: 'Assigned Agent' })

    ;(mockElectronAPI.db.getTask as unknown as Mock).mockResolvedValue({
      ...task,
      status: TaskStatus.NotStarted,
      agent_id: assignedAgent.id
    })

    renderHook(() =>
      useAgentAutoStart({
        tasks: [task],
        agents: [triageAgent, assignedAgent],
        sessions: new Map(),
        showToast: vi.fn()
      })
    )

    await act(async () => {
      vi.advanceTimersByTime(350)
      await Promise.resolve()
    })

    expect(mockElectronAPI.agentSession.start).toHaveBeenCalledWith(triageAgent.id, task.id, undefined, undefined)

    await act(async () => {
      getLatestAgentStatusCallback()?.({
        sessionId: 'triage-session',
        agentId: triageAgent.id,
        taskId: task.id,
        status: SessionStatus.IDLE
      })
      vi.advanceTimersByTime(600)
      await Promise.resolve()
    })

    const startCalls = (mockElectronAPI.agentSession.start as unknown as Mock).mock.calls
    expect(startCalls).toEqual(
      expect.arrayContaining([
        [assignedAgent.id, task.id, undefined, undefined]
      ])
    )
  })

  // ── Subtask auto-run tests ──

  it('does not auto-start parent tasks that have subtasks', async () => {
    const parentTask = makeTask({
      id: 'parent-1',
      title: 'Parent task',
      agent_id: 'agent-1',
      status: TaskStatus.NotStarted
    })
    const subtask = makeTask({
      id: 'sub-1',
      title: 'Subtask 1',
      parent_task_id: 'parent-1',
      agent_id: 'agent-1',
      sort_order: 0,
      status: TaskStatus.NotStarted
    })
    const agent = makeAgent({ id: 'agent-1', is_default: true })

    renderHook(() =>
      useAgentAutoStart({
        tasks: [parentTask, subtask],
        agents: [agent],
        sessions: new Map(),
        showToast: vi.fn()
      })
    )

    await act(async () => {
      vi.advanceTimersByTime(350)
      await Promise.resolve()
    })

    // Should start the first subtask, NOT the parent
    const startCalls = (mockElectronAPI.agentSession.start as unknown as Mock).mock.calls
    const startedTaskIds = startCalls.map((call: unknown[]) => call[1])
    expect(startedTaskIds).toContain('sub-1')
    expect(startedTaskIds).not.toContain('parent-1')
  })

  it('does not triage subtasks independently', async () => {
    const parentTask = makeTask({
      id: 'parent-notriage',
      title: 'Parent task',
      agent_id: 'agent-notriage',
      status: TaskStatus.AgentWorking
    })
    const subtask = makeTask({
      id: 'sub-notriage',
      title: 'Subtask without agent',
      parent_task_id: 'parent-notriage',
      agent_id: null,
      sort_order: 0,
      status: TaskStatus.NotStarted
    })
    const agent = makeAgent({ id: 'agent-notriage', is_default: true })

    renderHook(() =>
      useAgentAutoStart({
        tasks: [parentTask, subtask],
        agents: [agent],
        sessions: new Map(),
        showToast: vi.fn()
      })
    )

    await act(async () => {
      vi.advanceTimersByTime(350)
      await Promise.resolve()
    })

    // Should NOT triage the subtask (parent_task_id is set)
    expect(mockElectronAPI.db.updateTask).not.toHaveBeenCalledWith('sub-notriage', { status: TaskStatus.Triaging })
    // Subtask should not be started (no agent_id and parent is already working)
    const startCalls = (mockElectronAPI.agentSession.start as unknown as Mock).mock.calls
    const subtaskStartCalls = startCalls.filter((call: unknown[]) => call[1] === 'sub-notriage')
    expect(subtaskStartCalls).toHaveLength(0)
  })

  it('only starts first subtask when multiple subtasks are not_started', async () => {
    const parentTask = makeTask({
      id: 'parent-1',
      title: 'Parent task',
      agent_id: 'agent-1',
      status: TaskStatus.NotStarted
    })
    const subtask1 = makeTask({
      id: 'sub-1',
      title: 'Subtask 1',
      parent_task_id: 'parent-1',
      agent_id: 'agent-1',
      sort_order: 0,
      status: TaskStatus.NotStarted
    })
    const subtask2 = makeTask({
      id: 'sub-2',
      title: 'Subtask 2',
      parent_task_id: 'parent-1',
      agent_id: 'agent-1',
      sort_order: 1,
      status: TaskStatus.NotStarted
    })
    const agent = makeAgent({ id: 'agent-1', is_default: true })

    renderHook(() =>
      useAgentAutoStart({
        tasks: [parentTask, subtask1, subtask2],
        agents: [agent],
        sessions: new Map(),
        showToast: vi.fn()
      })
    )

    await act(async () => {
      vi.advanceTimersByTime(350)
      await Promise.resolve()
    })

    // Should only start subtask 1, not subtask 2
    const startCalls = (mockElectronAPI.agentSession.start as unknown as Mock).mock.calls
    const startedTaskIds = startCalls.map((call: unknown[]) => call[1])
    expect(startedTaskIds).toContain('sub-1')
    expect(startedTaskIds).not.toContain('sub-2')
  })

  it('does not start next subtask while sibling is in ReadyForReview', async () => {
    const parentTask = makeTask({
      id: 'parent-1',
      title: 'Parent task',
      agent_id: 'agent-1',
      status: TaskStatus.NotStarted
    })
    const subtask1 = makeTask({
      id: 'sub-1',
      title: 'Subtask 1',
      parent_task_id: 'parent-1',
      agent_id: 'agent-1',
      sort_order: 0,
      status: TaskStatus.ReadyForReview
    })
    const subtask2 = makeTask({
      id: 'sub-2',
      title: 'Subtask 2',
      parent_task_id: 'parent-1',
      agent_id: 'agent-1',
      sort_order: 1,
      status: TaskStatus.NotStarted
    })
    const agent = makeAgent({ id: 'agent-1', is_default: true })

    renderHook(() =>
      useAgentAutoStart({
        tasks: [parentTask, subtask1, subtask2],
        agents: [agent],
        sessions: new Map(),
        showToast: vi.fn()
      })
    )

    await act(async () => {
      vi.advanceTimersByTime(350)
      await Promise.resolve()
    })

    // Should NOT start subtask 2 — subtask 1 is still in ReadyForReview
    const startCalls = (mockElectronAPI.agentSession.start as unknown as Mock).mock.calls
    const sub2StartCalls = startCalls.filter((call: unknown[]) => call[1] === 'sub-2')
    expect(sub2StartCalls).toHaveLength(0)
  })

  it('starts first subtask instead of parent after triage creates subtasks', async () => {
    const task = makeTask({ id: 'task-3', title: 'Complex task' })
    const triageAgent = makeAgent({ id: 'agent-triage', is_default: true, name: 'Triage Agent' })
    const subtaskAgent = makeAgent({ id: 'agent-sub', is_default: false, name: 'Subtask Agent' })

    // After triage: task has agent_id and subtasks
    ;(mockElectronAPI.db.getTask as unknown as Mock).mockResolvedValue({
      ...task,
      status: TaskStatus.NotStarted,
      agent_id: subtaskAgent.id
    })

    // Triage created subtasks
    const subtasks = [
      makeTask({
        id: 'sub-1',
        title: 'Step 1',
        parent_task_id: 'task-3',
        agent_id: 'agent-sub',
        sort_order: 0,
        status: TaskStatus.NotStarted
      }),
      makeTask({
        id: 'sub-2',
        title: 'Step 2',
        parent_task_id: 'task-3',
        agent_id: 'agent-sub',
        sort_order: 1,
        status: TaskStatus.NotStarted
      })
    ]
    ;(mockElectronAPI.db.getSubtasks as unknown as Mock).mockResolvedValue(subtasks)

    renderHook(() =>
      useAgentAutoStart({
        tasks: [task],
        agents: [triageAgent, subtaskAgent],
        sessions: new Map(),
        showToast: vi.fn()
      })
    )

    // Trigger triage
    await act(async () => {
      vi.advanceTimersByTime(350)
      await Promise.resolve()
    })

    expect(mockElectronAPI.agentSession.start).toHaveBeenCalledWith(triageAgent.id, task.id, undefined, undefined)

    // Complete triage → agent goes idle
    await act(async () => {
      getLatestAgentStatusCallback()?.({
        sessionId: 'triage-session',
        agentId: triageAgent.id,
        taskId: task.id,
        status: SessionStatus.IDLE
      })
      vi.advanceTimersByTime(600)
      await Promise.resolve()
    })

    // Should start the first subtask, NOT the parent task
    const startCalls = (mockElectronAPI.agentSession.start as unknown as Mock).mock.calls
    const startedTaskIds = startCalls.map((call: unknown[]) => call[1])
    expect(startedTaskIds).toContain('sub-1')
    // Parent task should NOT be started directly
    const parentStartCalls = startCalls.filter((call: unknown[]) => call[0] === subtaskAgent.id && call[1] === task.id)
    expect(parentStartCalls).toHaveLength(0)
  })

  it('starts next subtask when previous subtask is completed via task update', async () => {
    const parentTask = makeTask({
      id: 'parent-next',
      title: 'Parent task',
      agent_id: 'agent-next',
      status: TaskStatus.NotStarted
    })
    // Start with subtask1 in ReadyForReview — prevents subtask2 from auto-starting initially
    const subtask1 = makeTask({
      id: 'sub-next-1',
      title: 'Subtask 1',
      parent_task_id: 'parent-next',
      agent_id: 'agent-next',
      sort_order: 0,
      status: TaskStatus.ReadyForReview
    })
    const subtask2 = makeTask({
      id: 'sub-next-2',
      title: 'Subtask 2',
      parent_task_id: 'parent-next',
      agent_id: 'agent-next',
      sort_order: 1,
      status: TaskStatus.NotStarted
    })
    const agent = makeAgent({ id: 'agent-next', is_default: true })

    // When startNextSubtask fetches parent task, return it with NotStarted status
    ;(mockElectronAPI.db.getTask as unknown as Mock).mockResolvedValue(parentTask)

    // When startNextSubtask fetches subtasks, return them with sub1 now completed
    ;(mockElectronAPI.db.getSubtasks as unknown as Mock).mockResolvedValue([
      { ...subtask1, status: TaskStatus.Completed },
      subtask2
    ])

    renderHook(() =>
      useAgentAutoStart({
        tasks: [parentTask, subtask1, subtask2],
        agents: [agent],
        sessions: new Map(),
        showToast: vi.fn()
      })
    )

    // Wait for initial render + debounce — subtask2 should NOT be started (sibling in ReadyForReview)
    await act(async () => {
      vi.advanceTimersByTime(350)
      await Promise.resolve()
    })

    // Verify subtask2 was not started during initial check
    const initialStartCalls = (mockElectronAPI.agentSession.start as unknown as Mock).mock.calls
    expect(initialStartCalls.filter((c: unknown[]) => c[1] === 'sub-next-2')).toHaveLength(0)

    ;(mockElectronAPI.agentSession.start as unknown as Mock).mockClear()

    // Get the onTaskUpdated callback
    const taskUpdatedCalls = (mockElectronAPI.onTaskUpdated as unknown as Mock).mock.calls
    const latestTaskUpdatedCb = taskUpdatedCalls[taskUpdatedCalls.length - 1]?.[0]
    expect(latestTaskUpdatedCb).toBeDefined()

    // Simulate subtask 1 being completed → triggers startNextSubtask via 300ms setTimeout
    await act(async () => {
      latestTaskUpdatedCb?.({
        taskId: 'sub-next-1',
        updates: { status: TaskStatus.Completed }
      })
      // Advance past the 300ms setTimeout and flush async chain
      await vi.advanceTimersByTimeAsync(400)
    })

    // Should start subtask 2 after subtask 1 is completed
    const startCalls = (mockElectronAPI.agentSession.start as unknown as Mock).mock.calls
    const startedTaskIds = startCalls.map((call: unknown[]) => call[1])
    expect(startedTaskIds).toContain('sub-next-2')
  })

  it('marks parent as ready for review when all subtasks are completed', async () => {
    const parentTask = makeTask({
      id: 'parent-1',
      title: 'Parent task',
      agent_id: 'agent-1',
      status: TaskStatus.NotStarted
    })
    const subtask1 = makeTask({
      id: 'sub-1',
      title: 'Subtask 1',
      parent_task_id: 'parent-1',
      agent_id: 'agent-1',
      sort_order: 0,
      status: TaskStatus.Completed
    })
    const subtask2 = makeTask({
      id: 'sub-2',
      title: 'Subtask 2',
      parent_task_id: 'parent-1',
      agent_id: 'agent-1',
      sort_order: 1,
      status: TaskStatus.Completed
    })
    const agent = makeAgent({ id: 'agent-1', is_default: true })

    // When startNextSubtask fetches parent task, return it with NotStarted status
    ;(mockElectronAPI.db.getTask as unknown as Mock).mockResolvedValue(parentTask)

    // All subtasks completed
    ;(mockElectronAPI.db.getSubtasks as unknown as Mock).mockResolvedValue([subtask1, subtask2])

    renderHook(() =>
      useAgentAutoStart({
        tasks: [parentTask, subtask1, subtask2],
        agents: [agent],
        sessions: new Map(),
        showToast: vi.fn()
      })
    )

    await act(async () => {
      vi.advanceTimersByTime(350)
      await Promise.resolve()
    })

    ;(mockElectronAPI.db.updateTask as unknown as Mock).mockClear()

    // Get the onTaskUpdated callback
    const taskUpdatedCalls = (mockElectronAPI.onTaskUpdated as unknown as Mock).mock.calls
    const latestTaskUpdatedCb = taskUpdatedCalls[taskUpdatedCalls.length - 1]?.[0]

    // Simulate the last subtask being completed
    await act(async () => {
      latestTaskUpdatedCb?.({
        taskId: 'sub-2',
        updates: { status: TaskStatus.Completed }
      })
      vi.advanceTimersByTime(400)
      await Promise.resolve()
    })

    // Should mark parent as ReadyForReview
    expect(mockElectronAPI.db.updateTask).toHaveBeenCalledWith('parent-1', { status: TaskStatus.ReadyForReview })
  })

  // ── Parent status guard tests ──

  it('does not start subtasks when parent is in ReadyForReview status', async () => {
    const parentTask = makeTask({
      id: 'parent-rfr',
      title: 'Parent in review',
      agent_id: 'agent-1',
      status: TaskStatus.ReadyForReview
    })
    const subtask = makeTask({
      id: 'sub-rfr',
      title: 'Subtask 1',
      parent_task_id: 'parent-rfr',
      agent_id: 'agent-1',
      sort_order: 0,
      status: TaskStatus.NotStarted
    })
    const agent = makeAgent({ id: 'agent-1', is_default: true })

    renderHook(() =>
      useAgentAutoStart({
        tasks: [parentTask, subtask],
        agents: [agent],
        sessions: new Map(),
        showToast: vi.fn()
      })
    )

    await act(async () => {
      vi.advanceTimersByTime(350)
      await Promise.resolve()
    })

    // Subtask should NOT be started — parent is in ReadyForReview
    const startCalls = (mockElectronAPI.agentSession.start as unknown as Mock).mock.calls
    const startedTaskIds = startCalls.map((call: unknown[]) => call[1])
    expect(startedTaskIds).not.toContain('sub-rfr')
  })

  it('does not start subtasks when parent is in Completed status', async () => {
    const parentTask = makeTask({
      id: 'parent-done',
      title: 'Parent completed',
      agent_id: 'agent-1',
      status: TaskStatus.Completed
    })
    const subtask = makeTask({
      id: 'sub-done',
      title: 'Subtask 1',
      parent_task_id: 'parent-done',
      agent_id: 'agent-1',
      sort_order: 0,
      status: TaskStatus.NotStarted
    })
    const agent = makeAgent({ id: 'agent-1', is_default: true })

    renderHook(() =>
      useAgentAutoStart({
        tasks: [parentTask, subtask],
        agents: [agent],
        sessions: new Map(),
        showToast: vi.fn()
      })
    )

    await act(async () => {
      vi.advanceTimersByTime(350)
      await Promise.resolve()
    })

    // Subtask should NOT be started — parent is Completed
    const startCalls = (mockElectronAPI.agentSession.start as unknown as Mock).mock.calls
    const startedTaskIds = startCalls.map((call: unknown[]) => call[1])
    expect(startedTaskIds).not.toContain('sub-done')
  })

  it('does not start subtasks when parent is in AgentWorking status', async () => {
    const parentTask = makeTask({
      id: 'parent-working',
      title: 'Parent working',
      agent_id: 'agent-1',
      status: TaskStatus.AgentWorking
    })
    const subtask = makeTask({
      id: 'sub-working',
      title: 'Subtask 1',
      parent_task_id: 'parent-working',
      agent_id: 'agent-1',
      sort_order: 0,
      status: TaskStatus.NotStarted
    })
    const agent = makeAgent({ id: 'agent-1', is_default: true })

    renderHook(() =>
      useAgentAutoStart({
        tasks: [parentTask, subtask],
        agents: [agent],
        sessions: new Map(),
        showToast: vi.fn()
      })
    )

    await act(async () => {
      vi.advanceTimersByTime(350)
      await Promise.resolve()
    })

    // Subtask should NOT be started — parent is AgentWorking
    const startCalls = (mockElectronAPI.agentSession.start as unknown as Mock).mock.calls
    const startedTaskIds = startCalls.map((call: unknown[]) => call[1])
    expect(startedTaskIds).not.toContain('sub-working')
  })

  it('does not start next subtask via startNextSubtask when parent is no longer NotStarted', async () => {
    const parentTask = makeTask({
      id: 'parent-changed',
      title: 'Parent changed status',
      agent_id: 'agent-1',
      status: TaskStatus.NotStarted
    })
    const subtask1 = makeTask({
      id: 'sub-changed-1',
      title: 'Subtask 1',
      parent_task_id: 'parent-changed',
      agent_id: 'agent-1',
      sort_order: 0,
      status: TaskStatus.ReadyForReview
    })
    const subtask2 = makeTask({
      id: 'sub-changed-2',
      title: 'Subtask 2',
      parent_task_id: 'parent-changed',
      agent_id: 'agent-1',
      sort_order: 1,
      status: TaskStatus.NotStarted
    })
    const agent = makeAgent({ id: 'agent-1', is_default: true })

    // Parent has been moved to Completed in the DB (e.g. manually by user)
    ;(mockElectronAPI.db.getTask as unknown as Mock).mockResolvedValue({
      ...parentTask,
      status: TaskStatus.Completed
    })

    ;(mockElectronAPI.db.getSubtasks as unknown as Mock).mockResolvedValue([
      { ...subtask1, status: TaskStatus.Completed },
      subtask2
    ])

    renderHook(() =>
      useAgentAutoStart({
        tasks: [parentTask, subtask1, subtask2],
        agents: [agent],
        sessions: new Map(),
        showToast: vi.fn()
      })
    )

    await act(async () => {
      vi.advanceTimersByTime(350)
      await Promise.resolve()
    })

    ;(mockElectronAPI.agentSession.start as unknown as Mock).mockClear()

    // Get the onTaskUpdated callback
    const taskUpdatedCalls = (mockElectronAPI.onTaskUpdated as unknown as Mock).mock.calls
    const latestTaskUpdatedCb = taskUpdatedCalls[taskUpdatedCalls.length - 1]?.[0]

    // Simulate subtask 1 being completed → triggers startNextSubtask
    await act(async () => {
      latestTaskUpdatedCb?.({
        taskId: 'sub-changed-1',
        updates: { status: TaskStatus.Completed }
      })
      await vi.advanceTimersByTimeAsync(400)
    })

    // startNextSubtask should NOT start subtask 2 — parent is Completed in DB
    const startCalls = (mockElectronAPI.agentSession.start as unknown as Mock).mock.calls
    const startedTaskIds = startCalls.map((call: unknown[]) => call[1])
    expect(startedTaskIds).not.toContain('sub-changed-2')

    // Should also NOT mark parent as ReadyForReview
    expect(mockElectronAPI.db.updateTask).not.toHaveBeenCalledWith('parent-changed', { status: TaskStatus.ReadyForReview })
  })
})
