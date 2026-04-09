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
})
