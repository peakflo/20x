import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { captureAnalyticsEvent } from '@/lib/analytics'
import { onEvent } from '../api/websocket'
import { useAgentStore, SessionStatus, __clearProjectionsForTest } from './agent-store'
import { api, type TranscriptPartRecord } from '../api/client'
import { FakeTranscriptServer, type FakeTranscriptWrite } from '@shared/transcript-stream.testing'
import type { TranscriptDeltaEvent } from '@shared/transcript-stream'

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
const syncMock = api.transcript.sync as unknown as Mock

// The main process side: an in-memory transcript with the real delta encoder.
let server: FakeTranscriptServer

beforeEach(() => {
  useAgentStore.setState({ agents: [], skills: [], sessions: new Map() })
  __clearProjectionsForTest()
  vi.clearAllMocks()
  server = new FakeTranscriptServer('epoch-1')
  syncMock.mockImplementation(async (taskId: string, sinceRev?: number) => server.sync(taskId, sinceRev))
})

/** Write parts on the "desktop" and deliver the resulting WS event. */
function push(taskId: string, writes: FakeTranscriptWrite[]): TranscriptDeltaEvent {
  const event = server.write(taskId, writes)
  transcriptHandler(event)
  return event
}

const content = (taskId: string): string[] => (useAgentStore.getState().sessions.get(taskId)?.messages ?? []).map((m) => m.content)
const ids = (taskId: string): string[] => (useAgentStore.getState().sessions.get(taskId)?.messages ?? []).map((m) => m.id)
const fullSyncCalls = (): string[] => syncMock.mock.calls.filter((call) => typeof call[1] !== 'number').map((call) => call[0] as string)

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function setSession(taskId: string, status: SessionStatus, sessionId: string | null = 'sess-1', agentId = 'agent-1'): void {
  useAgentStore.setState((state) => ({
    sessions: new Map(state.sessions).set(taskId, {
      sessionId,
      agentId,
      taskId,
      status,
      messages: state.sessions.get(taskId)?.messages ?? []
    })
  }))
}

function snapshotPart(partId: string, over: Partial<TranscriptPartRecord> = {}): TranscriptPartRecord {
  return {
    taskId: 'task-1', partId, seq: over.seq ?? 0, role: 'assistant', content: over.content ?? `msg-${partId}`,
    createdAt: over.createdAt ?? 1000, updatedAt: 1000, rev: over.rev ?? 1, ...over
  }
}

describe('useAgentStore (projection model)', () => {
  describe('bindTranscript', () => {
    it('renders a sorted derived message list from the snapshot', async () => {
      syncMock.mockResolvedValueOnce({
        taskId: 'task-1', epoch: 'epoch-1', seq: 0, maxRev: 2, full: true,
        parts: [
          snapshotPart('b', { seq: 2, createdAt: 2000, content: 'second' }),
          snapshotPart('a', { seq: 1, createdAt: 1000, content: 'first' })
        ]
      })

      await useAgentStore.getState().bindTranscript('task-1')

      expect(syncMock).toHaveBeenCalledWith('task-1', undefined)
      expect(ids('task-1')).toEqual(['a', 'b'])
      expect(content('task-1')[0]).toBe('first')
    })

    it('creates no spurious session on an empty snapshot, but follows the task', async () => {
      await useAgentStore.getState().bindTranscript('task-1')
      expect(useAgentStore.getState().sessions.get('task-1')).toBeUndefined()
      // The first messages of the (now running) task still show up.
      push('task-1', [{ partId: 'a', content: 'hello' }])
      expect(content('task-1')).toEqual(['hello'])
    })

    it('replaces (not appends) the projection when re-binding a snapshot', async () => {
      server.write('task-1', [{ partId: 'a' }, { partId: 'b' }])
      await useAgentStore.getState().bindTranscript('task-1')
      __clearProjectionsForTest() // simulate fresh module — snapshot is authoritative
      syncMock.mockResolvedValueOnce({ ...server.sync('task-1'), parts: server.parts('task-1').slice(0, 1) })
      await useAgentStore.getState().bindTranscript('task-1')
      expect(useAgentStore.getState().sessions.get('task-1')!.messages).toHaveLength(1)
    })
  })

  describe('transcript:changed delta stream', () => {
    it('applies whole parts and appended text after bind', async () => {
      await useAgentStore.getState().bindTranscript('task-1')
      expect(push('task-1', [{ partId: 'a', content: 'Hel' }]).ops[0].op).toBe('put')
      const append = push('task-1', [{ partId: 'a', content: 'Hello' }])
      expect(append.ops).toEqual([expect.objectContaining({ op: 'append', at: 3, text: 'lo' })])
      expect(content('task-1')).toEqual(['Hello'])
      expect(syncMock).toHaveBeenCalledTimes(1)
    })

    it('ignores deltas for tasks this client does not follow (no fetch)', () => {
      push('task-1', [{ partId: 'a' }])
      expect(useAgentStore.getState().sessions.size).toBe(0)
      expect(syncMock).not.toHaveBeenCalled()
    })

    it('ignores deltas with no taskId or no ops', () => {
      transcriptHandler({ ops: [] })
      transcriptHandler({ taskId: 'task-1' })
      expect(useAgentStore.getState().sessions.size).toBe(0)
    })

    it('drops a stale or duplicate event', async () => {
      await useAgentStore.getState().bindTranscript('task-1')
      const event = push('task-1', [{ partId: 'a', content: 'one' }])
      const sessions = useAgentStore.getState().sessions
      transcriptHandler(event)
      expect(useAgentStore.getState().sessions).toBe(sessions)
      expect(content('task-1')).toEqual(['one'])
    })

    it('gap -> catches up since its rev, then keeps applying appends', async () => {
      await useAgentStore.getState().bindTranscript('task-1')
      push('task-1', [{ partId: 'a', content: 'A' }])
      syncMock.mockClear()
      server.write('task-1', [{ partId: 'a', content: 'AB' }]) // lost
      push('task-1', [{ partId: 'a', content: 'ABC' }])
      expect(content('task-1')).toEqual(['A'])
      await settle()
      expect(syncMock).toHaveBeenCalledWith('task-1', expect.any(Number))
      expect(fullSyncCalls()).toEqual([])
      expect(content('task-1')).toEqual(['ABC'])
      push('task-1', [{ partId: 'a', content: 'ABCD' }])
      expect(content('task-1')).toEqual(['ABCD'])
    })

    it('out-of-order events converge to the latest content', async () => {
      await useAgentStore.getState().bindTranscript('task-1')
      push('task-1', [{ partId: 'a', content: '1' }])
      const e2 = server.write('task-1', [{ partId: 'a', content: '12' }])
      const e3 = server.write('task-1', [{ partId: 'a', content: '123' }])
      transcriptHandler(e3)
      transcriptHandler(e2)
      await settle()
      expect(content('task-1')).toEqual(['123'])
    })

    it('a patch of an earlier part replaces it in place', async () => {
      await useAgentStore.getState().bindTranscript('task-1')
      push('task-1', [{ partId: 'a', content: 'draft', createdAt: 100 }, { partId: 'b', content: 'tail', createdAt: 200 }])
      const patch = push('task-1', [{ partId: 'a', content: 'rewritten' }])
      expect(patch.ops[0].op).toBe('put')
      expect(content('task-1')).toEqual(['rewritten', 'tail'])
    })

    it('reconnect -> every followed task reloads its whole transcript', async () => {
      ;(api.sessions.list as unknown as Mock).mockResolvedValue([])
      await useAgentStore.getState().bindTranscript('task-1')
      push('task-1', [{ partId: 'a', content: 'x' }])
      syncMock.mockClear()
      // Sent while the socket was down.
      server.write('task-1', [{ partId: 'a', content: 'xy' }])
      await useAgentStore.getState().syncActiveSessions() // reconnect handler
      expect(fullSyncCalls()).toEqual(['task-1'])
      expect(content('task-1')).toEqual(['xy'])
      push('task-1', [{ partId: 'a', content: 'xyz' }])
      expect(content('task-1')).toEqual(['xyz'])
    })

    it('a new sender epoch (desktop restarted) reloads the whole transcript', async () => {
      await useAgentStore.getState().bindTranscript('task-1')
      push('task-1', [{ partId: 'a', content: 'before' }])
      syncMock.mockClear()
      server.restart('epoch-2')
      push('task-1', [{ partId: 'a', content: 'before after' }])
      await settle()
      expect(fullSyncCalls()).toEqual(['task-1'])
      expect(content('task-1')).toEqual(['before after'])
    })

    it('an append that does not fit local content triggers a full resync', async () => {
      await useAgentStore.getState().bindTranscript('task-1')
      push('task-1', [{ partId: 'a', content: 'abc' }])
      syncMock.mockClear()
      const event = server.write('task-1', [{ partId: 'a', content: 'abcd' }])
      transcriptHandler({ ...event, ops: [{ ...event.ops[0], at: 99 }] })
      await settle()
      expect(fullSyncCalls()).toEqual(['task-1'])
      expect(content('task-1')).toEqual(['abcd'])
    })

    it('batches output analytics until the task goes idle', async () => {
      await useAgentStore.getState().bindTranscript('task-1')
      setSession('task-1', SessionStatus.WORKING)

      push('task-1', [
        { partId: 'p1', content: 'one' },
        { partId: 't1', partType: 'tool', content: '', tool: { name: 'Bash', status: 'success' } }
      ])
      push('task-1', [{ partId: 't2', partType: 'tool', content: '', tool: { name: 'Read', status: 'success' } }])

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
      expect(syncMock).not.toHaveBeenCalled()
    })

    it('registers active sessions and binds each transcript from the projection', async () => {
      ;(api.sessions.list as unknown as Mock).mockResolvedValue([
        { sessionId: 'sess-1', agentId: 'agent-1', taskId: 'task-1', status: 'working' }
      ])
      server.write('task-1', [{ partId: 'm1' }])

      await useAgentStore.getState().syncActiveSessions()

      expect(syncMock).toHaveBeenCalledWith('task-1', undefined)
      const s = useAgentStore.getState().sessions.get('task-1')!
      expect(s.sessionId).toBe('sess-1')
      expect(s.status).toBe('working')
      expect(s.messages.map((m) => m.id)).toEqual(['m1'])
    })

    it('does not call the removed replay/sync endpoint', async () => {
      ;(api.sessions.list as unknown as Mock).mockResolvedValue([
        { sessionId: 'sess-1', agentId: 'agent-1', taskId: 'task-1', status: 'working' }
      ])
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
    it('updates status without touching the derived messages', async () => {
      await useAgentStore.getState().bindTranscript('task-1')
      setSession('task-1', SessionStatus.WORKING)
      push('task-1', [{ partId: 'm1' }])

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

    it('catches a followed task up since its rev on idle (safety net)', async () => {
      await useAgentStore.getState().bindTranscript('task-1')
      setSession('task-1', SessionStatus.WORKING)
      syncMock.mockClear()
      statusHandler({ sessionId: 'sess-1', agentId: 'agent-1', taskId: 'task-1', status: SessionStatus.IDLE })
      expect(syncMock).toHaveBeenCalledWith('task-1', 0)
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

    it('endSession goes idle and clears sessionId but preserves the derived messages', async () => {
      await useAgentStore.getState().bindTranscript('task-1')
      setSession('task-1', SessionStatus.WORKING)
      push('task-1', [{ partId: 'm1' }])
      useAgentStore.getState().endSession('task-1')
      const s = useAgentStore.getState().sessions.get('task-1')!
      expect(s.sessionId).toBeNull()
      expect(s.status).toBe(SessionStatus.IDLE)
      expect(s.messages).toHaveLength(1)
    })

    it('removeSession removes the session entirely and stops following the task', async () => {
      await useAgentStore.getState().bindTranscript('task-1')
      setSession('task-1', SessionStatus.WORKING)
      useAgentStore.getState().removeSession('task-1')
      expect(useAgentStore.getState().sessions.get('task-1')).toBeUndefined()
      syncMock.mockClear()
      push('task-1', [{ partId: 'm1' }])
      expect(syncMock).not.toHaveBeenCalled()
    })

    it('clearMessageDedup is a no-op (projection is the source of truth)', async () => {
      await useAgentStore.getState().bindTranscript('task-1')
      setSession('task-1', SessionStatus.WORKING)
      push('task-1', [{ partId: 'm1' }, { partId: 'm2' }])
      useAgentStore.getState().clearMessageDedup('task-1')
      expect(useAgentStore.getState().sessions.get('task-1')!.messages).toHaveLength(2)
    })
  })
})
