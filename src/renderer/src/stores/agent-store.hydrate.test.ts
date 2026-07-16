import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useAgentStore, SessionStatus } from './agent-store'
import type { AgentMessage } from './agent-store'

// window.electronAPI is provided by test/setup-renderer.ts; we override the
// snapshot mock per test.
const getSnapshotMock = window.electronAPI.agentSession.getTranscriptSnapshot as ReturnType<typeof vi.fn>

function part(partId: string, seq: number, overrides: Record<string, unknown> = {}) {
  return {
    taskId: 'task-1',
    partId,
    seq,
    role: 'assistant',
    content: `content-${partId}`,
    createdAt: 1000 + seq,
    updatedAt: 1000 + seq,
    ...overrides
  }
}

describe('agent-store transcript hydration', () => {
  beforeEach(() => {
    getSnapshotMock.mockReset()
    useAgentStore.setState({ sessions: new Map() })
  })

  it('hydrates a task the renderer has never seen (background wake-up turn)', async () => {
    getSnapshotMock.mockResolvedValue([
      part('p1', 1, { role: 'user', content: 'wake-up prompt' }),
      part('p2', 2, { content: 'ACK — resumed and reviewed subtasks' })
    ])

    await useAgentStore.getState().hydrateTranscript('task-1')

    const session = useAgentStore.getState().sessions.get('task-1')
    expect(session).toBeDefined()
    expect(session!.status).toBe(SessionStatus.IDLE)
    expect(session!.messages.map((m: AgentMessage) => [m.id, m.role, m.content])).toEqual([
      ['p1', 'user', 'wake-up prompt'],
      ['p2', 'assistant', 'ACK — resumed and reviewed subtasks']
    ])
  })

  it('snapshot is authoritative for content/order; in-memory extras are preserved', async () => {
    // Existing in-memory session with a stale part and an ephemeral extra
    useAgentStore.setState({
      sessions: new Map([['task-1', {
        sessionId: 's1',
        agentId: 'a1',
        taskId: 'task-1',
        status: SessionStatus.WORKING,
        messages: [
          { id: 'p1', role: 'assistant', content: 'stale partial', timestamp: new Date(1) },
          { id: 'ephemeral-1', role: 'system', content: 'transient note', timestamp: new Date(2) }
        ] as AgentMessage[],
        pendingApproval: null
      }]])
    })

    getSnapshotMock.mockResolvedValue([
      part('p1', 1, { content: 'final complete content' }),
      part('p2', 2)
    ])

    await useAgentStore.getState().hydrateTranscript('task-1')

    const messages = useAgentStore.getState().sessions.get('task-1')!.messages
    expect(messages.map((m: AgentMessage) => m.id)).toEqual(['p1', 'p2', 'ephemeral-1'])
    expect(messages[0].content).toBe('final complete content')
    // Session metadata (status, ids) untouched by hydration
    expect(useAgentStore.getState().sessions.get('task-1')!.status).toBe(SessionStatus.WORKING)
  })

  it('does nothing for empty snapshots', async () => {
    getSnapshotMock.mockResolvedValue([])
    await useAgentStore.getState().hydrateTranscript('task-unknown')
    expect(useAgentStore.getState().sessions.has('task-unknown')).toBe(false)
  })
})
