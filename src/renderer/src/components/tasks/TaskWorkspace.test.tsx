import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, fireEvent, screen, waitFor, cleanup } from '@testing-library/react'
import { TaskWorkspace } from './TaskWorkspace'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { TaskStatus } from '@/types'
import type { WorkfloTask, Agent } from '@/types'

vi.mock('@/components/agents/AgentTranscriptPanel', () => ({
  AgentTranscriptPanel: ({ onSend }: { onSend?: (message: string) => void }) => (
    <button data-testid="mock-send" onClick={() => onSend?.('approved')}>send</button>
  )
}))

// Add missing electronAPI mocks that child components need
const api = window.electronAPI as unknown as Record<string, unknown>
if (!api.onGithubDeviceCode) api.onGithubDeviceCode = vi.fn(() => vi.fn())
if (!api.tasks) api.tasks = { getWorkspaceDir: vi.fn().mockResolvedValue('/tmp') }

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
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    parent_task_id: null,
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
  vi.clearAllMocks()
})

describe('TaskWorkspace – stale triage session cleanup', () => {
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

  it('routes stale question replies to sendMessage when not waiting approval', async () => {
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

    await waitFor(() => {
      expect(window.electronAPI.agentSession.send).toHaveBeenCalledWith('session-1', 'approved', taskId, agentId)
    })
    expect(window.electronAPI.agentSession.approve).not.toHaveBeenCalled()
  })
})
