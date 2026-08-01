import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { captureAnalyticsEvent } from '@/lib/analytics'
import { onEvent } from '../api/websocket'
import { useAgentStore, SessionStatus, __clearProjectionsForTest } from './agent-store'
import { api, type TranscriptPartRecord } from '../api/client'

vi.mock('@/lib/analytics', () => ({
  captureAnalyticsEvent: vi.fn()
}))

// Capture the onEvent callbacks registered at store init time
const eventHandlers = new Map<string, (payload: unknown) => void>()
{
  const calls = (onEvent as unknown as Mock).mock.calls
  for (const [type, handler] of calls) {
    eventHandlers.set(type as string, handler as (payload: unknown) => void)
  }
}
const statusHandler = eventHandlers.get('agent:status')!
const transcriptHandler = eventHandlers.get('transcript:changed')!

beforeEach(() => {
  useAgentStore.setState({ agents: [], skills: [], sessions: new Map() })
  __clearProjectionsForTest()
  vi.clearAllMocks()
})

function part(partId: string, over: Partial<TranscriptPartRecord> = {}): TranscriptPartRecord {
  return {
    taskId: over.taskId ?? 'task-1',
    partId,
    seq: over.seq ?? 0,
    role: over.role ?? 'assistant',
    content: over.content ?? `msg-${partId}`,
    partType: over.partType,
    tool: over.tool,
    payload: over.payload,
    createdAt: over.createdAt ?? 1000,
    updatedAt: over.updatedAt ?? 1000,
    rev: over.rev ?? 1
  }
}

function setSession(taskId: string, status: SessionStatus, sessionId: string | null = 'sess-1', agentId = 'agent-1'): void {
  useAgentStore.setState((state) => ({
    sessions: new Map(state.sessions).set(taskId, {
      sessionId,
      agentId,
      taskId,
      status,
      messages: []
    })
  }))
}

describe('useAgentStore (projection model)', () => {
  describe('bindTranscript', () => {
    it('renders a sorted derived message list from the snapshot', async () => {
      ;(api.transcript.snapshot as unknown as Mock).mockResolvedValue([
        part('b', { seq: 2, createdAt: 2000, content: 'second' }),
        part('a', { seq: 1, createdAt: 1000, content: 'first' })
      ])

      await useAgentStore.getState().bindTranscript('task-1')

      const s = useAgentStore.getState().sessions.get('task-1')!
      expect(s.messages.map((m) => m.id)).toEqual(['a', 'b'])
      expect(s.messages[0].content).toBe('first')
    })

    it('is a no-op on an empty snapshot (no spurious session)', async () => {
      ;(api.transcript.snapshot as unknown as Mock).mockResolvedValue([])
      await useAgentStore.getState().bindTranscript('task-1')
      expect(useAgentStore.getState().sessions.get('task-1')).toBeUndefined()
    })

    it('replaces (not appends) the projection when re-binding a snapshot', async () => {
      ;(api.transcript.snapshot as unknown as Mock).mockResolvedValueOnce([part('a'), part('b')])
      await useAgentStore.getState().bindTranscript('task-1')
      __clearProjectionsForTest() // simulate fresh module — snapshot is authoritative
      ;(api.transcript.snapshot as unknown as Mock).mockResolvedValueOnce([part('a')])
      await useAgentStore.getState().bindTranscript('task-1')
      const s = useAgentStore.getState().sessions.get('task-1')!
      expect(s.messages).toHaveLength(1)
    })
  })

  describe('transcript:changed delta', () => {
    it('applies a delta into the derived list', () => {
      transcriptHandler({ taskId: 'task-1', parts: [part('a')], maxRev: 1 })
      const s = useAgentStore.getState().sessions.get('task-1')!
      expect(s.messages.map((m) => m.id)).toEqual(['a'])
    })

    it('is idempotent when the same delta arrives twice', () => {
      transcriptHandler({ taskId: 'task-1', parts: [part('a', { rev: 1 })], maxRev: 1 })
      transcriptHandler({ taskId: 'task-1', parts: [part('a', { rev: 1 })], maxRev: 1 })
      const s = useAgentStore.getState().sessions.get('task-1')!
      expect(s.messages).toHaveLength(1)
    })

    it('updates content in place (streaming) without duplicating the row', () => {
      transcriptHandler({ taskId: 'task-1', parts: [part('a', { content: 'hel', rev: 1 })], maxRev: 1 })
      transcriptHandler({ taskId: 'task-1', parts: [part('a', { content: 'hello', rev: 2 })], maxRev: 2 })
      const s = useAgentStore.getState().sessions.get('task-1')!
      expect(s.messages).toHaveLength(1)
      expect(s.messages[0].content).toBe('hello')
    })

    it('orders out-of-order deltas by (createdAt, seq)', () => {
      transcriptHandler({ taskId: 'task-1', parts: [part('b', { seq: 2, createdAt: 2000 })], maxRev: 2 })
      transcriptHandler({ taskId: 'task-1', parts: [part('a', { seq: 1, createdAt: 1000 })], maxRev: 3 })
      const s = useAgentStore.getState().sessions.get('task-1')!
      expect(s.messages.map((m) => m.id)).toEqual(['a', 'b'])
    })

    it('ignores deltas with no taskId', () => {
      transcriptHandler({ parts: [part('a')], maxRev: 1 })
      expect(useAgentStore.getState().sessions.size).toBe(0)
    })

    it('batches output analytics until the task goes idle', () => {
      setSession('task-1', SessionStatus.WORKING)

      transcriptHandler({
        taskId: 'task-1',
        parts: [
          part('p1', { content: 'one', rev: 1 }),
          part('t1', { partType: 'tool', content: '', tool: { name: 'Bash', status: 'success' } as never, rev: 2 })
        ],
        maxRev: 2
      })
      transcriptHandler({
        taskId: 'task-1',
        parts: [part('t2', { partType: 'tool', content: '', tool: { name: 'Read', status: 'success' } as never, rev: 3 })],
        maxRev: 3
      })

      expect(captureAnalyticsEvent).not.toHaveBeenCalledWith('agent_output_batch_received', expect.anything())

      statusHandler({ sessionId: 'sess-1', agentId: 'agent-1', taskId: 'task-1', status: SessionStatus.IDLE })

      expect(captureAnalyticsEvent).toHaveBeenCalledWith('agent_output_batch_received', {
        task_id: 'task-1',
        agent_id: 'agent-1',
        session_id: 'sess-1',
        message_count: 3,
        tool_names: ['Bash', 'Read']
      })
      expect(captureAnalyticsEvent).toHaveBeenCalledTimes(2)

      statusHandler({ sessionId: 'sess-1', agentId: 'agent-1', taskId: 'task-1', status: SessionStatus.IDLE })
      expect(captureAnalyticsEvent).toHaveBeenCalledTimes(2)
    })
  })

  describe('syncActiveSessions', () => {
    it('does nothing when no active sessions are returned', async () => {
      ;(api.sessions.list as unknown as Mock).mockResolvedValue([])
      await useAgentStore.getState().syncActiveSessions()
      expect(useAgentStore.getState().sessions.size).toBe(0)
      expect(api.transcript.snapshot).not.toHaveBeenCalled()
    })

    it('registers active sessions and binds each transcript from the projection', async () => {
      ;(api.sessions.list as unknown as Mock).mockResolvedValue([
        { sessionId: 'sess-1', agentId: 'agent-1', taskId: 'task-1', status: 'working' }
      ])
      ;(api.transcript.snapshot as unknown as Mock).mockResolvedValue([part('m1')])

      await useAgentStore.getState().syncActiveSessions()

      expect(api.transcript.snapshot).toHaveBeenCalledWith('task-1')
      const s = useAgentStore.getState().sessions.get('task-1')!
      expect(s.sessionId).toBe('sess-1')
      expect(s.status).toBe('working')
      expect(s.messages.map((m) => m.id)).toEqual(['m1'])
    })

    it('does not call the removed replay/sync endpoint', async () => {
      ;(api.sessions.list as unknown as Mock).mockResolvedValue([
        { sessionId: 'sess-1', agentId: 'agent-1', taskId: 'task-1', status: 'working' }
      ])
      ;(api.transcript.snapshot as unknown as Mock).mockResolvedValue([])
      await useAgentStore.getState().syncActiveSessions()
      expect(api.sessions.sync).not.toHaveBeenCalled()
    })

    it('handles api.sessions.list failure gracefully', async () => {
      ;(api.sessions.list as unknown as Mock).mockRejectedValue(new Error('Server down'))
      await useAgentStore.getState().syncActiveSessions()
      expect(useAgentStore.getState().sessions.size).toBe(0)
    })
  })

  describe('agent:status (state only, never messages)', () => {
    it('updates status without touching the derived messages', () => {
      setSession('task-1', SessionStatus.WORKING)
      transcriptHandler({ taskId: 'task-1', parts: [part('m1')], maxRev: 1 })

      statusHandler({ sessionId: 'sess-1', agentId: 'agent-1', taskId: 'task-1', status: SessionStatus.WAITING_APPROVAL })

      const s = useAgentStore.getState().sessions.get('task-1')!
      expect(s.status).toBe(SessionStatus.WAITING_APPROVAL)
      expect(s.messages.map((m) => m.id)).toEqual(['m1'])
    })

    it('updates sessionId when status event carries a re-keyed session ID', () => {
      setSession('task-1', SessionStatus.WORKING, 'temp-uuid')
      statusHandler({ sessionId: 'real-session-id', agentId: 'agent-1', taskId: 'task-1', status: SessionStatus.WORKING })
      expect(useAgentStore.getState().sessions.get('task-1')!.sessionId).toBe('real-session-id')
    })

    it('updates sessionId when pre-registered with empty string', () => {
      setSession('task-1', SessionStatus.WORKING, '')
      statusHandler({ sessionId: 'new-session-id', agentId: 'agent-1', taskId: 'task-1', status: SessionStatus.WORKING })
      expect(useAgentStore.getState().sessions.get('task-1')!.sessionId).toBe('new-session-id')
    })

    it('reconciles the delta on idle for a known session', () => {
      setSession('task-1', SessionStatus.WORKING)
      ;(api.transcript.delta as unknown as Mock).mockResolvedValue({ parts: [], maxRev: 0 })
      statusHandler({ sessionId: 'sess-1', agentId: 'agent-1', taskId: 'task-1', status: SessionStatus.IDLE })
      expect(api.transcript.delta).toHaveBeenCalledWith('task-1', 0)
    })

    it('creates a session entry for a new active status event', () => {
      statusHandler({ sessionId: 'sess-x', agentId: 'agent-1', taskId: 'task-9', status: SessionStatus.WORKING })
      const s = useAgentStore.getState().sessions.get('task-9')!
      expect(s.sessionId).toBe('sess-x')
      expect(s.status).toBe(SessionStatus.WORKING)
    })
  })

  describe('lifecycle', () => {
    it('initSession creates a working session', () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')
      const s = useAgentStore.getState().sessions.get('task-1')!
      expect(s.sessionId).toBe('sess-1')
      expect(s.status).toBe(SessionStatus.WORKING)
    })

    it('endSession goes idle and clears sessionId but preserves the derived messages', () => {
      setSession('task-1', SessionStatus.WORKING)
      transcriptHandler({ taskId: 'task-1', parts: [part('m1')], maxRev: 1 })
      useAgentStore.getState().endSession('task-1')
      const s = useAgentStore.getState().sessions.get('task-1')!
      expect(s.sessionId).toBeNull()
      expect(s.status).toBe(SessionStatus.IDLE)
      expect(s.messages).toHaveLength(1)
    })

    it('removeSession removes the session entirely', () => {
      setSession('task-1', SessionStatus.WORKING)
      useAgentStore.getState().removeSession('task-1')
      expect(useAgentStore.getState().sessions.get('task-1')).toBeUndefined()
    })

    it('clearMessageDedup is a no-op (projection is the source of truth)', () => {
      setSession('task-1', SessionStatus.WORKING)
      transcriptHandler({ taskId: 'task-1', parts: [part('m1'), part('m2', { seq: 1 })], maxRev: 2 })
      useAgentStore.getState().clearMessageDedup('task-1')
      expect(useAgentStore.getState().sessions.get('task-1')!.messages).toHaveLength(2)
    })
  })
})
