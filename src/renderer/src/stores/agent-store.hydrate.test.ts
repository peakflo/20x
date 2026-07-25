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

  it('is additive and non-destructive on a live view — never reorders/replaces rendered rows', async () => {
    // Existing rendered rows the user is already looking at. Hydration must NOT
    // reorder or replace these (that corrupts the virtualizer). It only appends
    // snapshot parts not already rendered, at the end.
    useAgentStore.setState({
      sessions: new Map([['task-1', {
        sessionId: 's1',
        agentId: 'a1',
        taskId: 'task-1',
        status: SessionStatus.WORKING,
        messages: [
          { id: 'p1', role: 'assistant', content: 'already rendered A', timestamp: new Date(1) },
          { id: 'p2', role: 'assistant', content: 'already rendered B', timestamp: new Date(2) }
        ] as AgentMessage[],
        pendingApproval: null
      }]])
    })

    getSnapshotMock.mockResolvedValue([
      part('p1', 1, { content: 'already rendered A' }),
      part('p2', 2, { content: 'already rendered B' }),
      part('p3', 3, { content: 'newly persisted C' })
    ])

    await useAgentStore.getState().hydrateTranscript('task-1')

    const messages = useAgentStore.getState().sessions.get('task-1')!.messages
    // p1/p2 kept exactly (same objects/order, not replaced); only p3 appended.
    expect(messages.map((m: AgentMessage) => m.id)).toEqual(['p1', 'p2', 'p3'])
    expect(messages[0].content).toBe('already rendered A')
    expect(messages[2].content).toBe('newly persisted C')
    expect(useAgentStore.getState().sessions.get('task-1')!.status).toBe(SessionStatus.WORKING)
  })

  it('is idempotent — re-hydrating does not duplicate or reorder', async () => {
    getSnapshotMock.mockResolvedValue([
      part('p1', 1, { role: 'user', content: 'do the thing' }),
      part('p2', 2, { content: 'on it' })
    ])

    await useAgentStore.getState().hydrateTranscript('task-idem')
    const first = useAgentStore.getState().sessions.get('task-idem')!.messages.map((m) => m.id)
    await useAgentStore.getState().hydrateTranscript('task-idem')
    const second = useAgentStore.getState().sessions.get('task-idem')!.messages.map((m) => m.id)

    expect(second).toEqual(first)
    expect(second).toEqual(['p1', 'p2'])
  })

  it('does nothing for empty snapshots', async () => {
    getSnapshotMock.mockResolvedValue([])
    await useAgentStore.getState().hydrateTranscript('task-unknown')
    expect(useAgentStore.getState().sessions.has('task-unknown')).toBe(false)
  })
})
