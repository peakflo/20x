import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { useAgentStore, type AgentMessage, type TaskSession } from './agent-store'
import { api } from '../api/client'

beforeEach(() => {
  useAgentStore.setState({
    agents: [],
    skills: [],
    sessions: new Map()
  })
  vi.clearAllMocks()
})

function makeMessage(id: string, role: 'user' | 'assistant' | 'system' = 'assistant', content = `msg-${id}`): AgentMessage {
  return { id, role, content, timestamp: new Date() }
}

function setSession(taskId: string, session: Partial<TaskSession>): void {
  useAgentStore.setState((state) => ({
    sessions: new Map(state.sessions).set(taskId, {
      sessionId: session.sessionId ?? 'sess-1',
      agentId: session.agentId ?? 'agent-1',
      taskId,
      status: session.status ?? 'working',
      messages: session.messages ?? []
    })
  }))
}

describe('useAgentStore', () => {
  describe('syncActiveSessions', () => {
    it('does nothing when no active sessions are returned', async () => {
      // Pre-populate a session with messages
      setSession('task-1', {
        sessionId: 'sess-1',
        messages: [makeMessage('m1'), makeMessage('m2')]
      })
      ;(api.sessions.list as unknown as Mock).mockResolvedValue([])

      await useAgentStore.getState().syncActiveSessions()

      // Messages should be untouched
      const session = useAgentStore.getState().sessions.get('task-1')
      expect(session?.messages).toHaveLength(2)
      expect(session?.messages[0].id).toBe('m1')
    })

    it('preserves existing messages when same session reconnects', async () => {
      // Pre-populate a session with messages (simulating pre-disconnect state)
      setSession('task-1', {
        sessionId: 'sess-1',
        agentId: 'agent-1',
        status: 'working',
        messages: [makeMessage('m1'), makeMessage('m2'), makeMessage('m3')]
      })

      // Server returns the same session as active
      ;(api.sessions.list as unknown as Mock).mockResolvedValue([
        { sessionId: 'sess-1', agentId: 'agent-1', taskId: 'task-1', status: 'working' }
      ])
      ;(api.sessions.sync as unknown as Mock).mockResolvedValue({ success: true, status: 'working' })

      await useAgentStore.getState().syncActiveSessions()

      // Messages should be PRESERVED (not cleared)
      const session = useAgentStore.getState().sessions.get('task-1')
      expect(session?.messages).toHaveLength(3)
      expect(session?.messages[0].id).toBe('m1')
      expect(session?.messages[1].id).toBe('m2')
      expect(session?.messages[2].id).toBe('m3')

      // api.sessions.sync should still be called (to fetch missed messages)
      expect(api.sessions.sync).toHaveBeenCalledWith('sess-1')
    })

    it('preserves messages when sync request fails on same session', async () => {
      setSession('task-1', {
        sessionId: 'sess-1',
        messages: [makeMessage('m1'), makeMessage('m2')]
      })

      ;(api.sessions.list as unknown as Mock).mockResolvedValue([
        { sessionId: 'sess-1', agentId: 'agent-1', taskId: 'task-1', status: 'working' }
      ])
      // Sync fails (network error, server error, etc.)
      ;(api.sessions.sync as unknown as Mock).mockRejectedValue(new Error('Network error'))

      await useAgentStore.getState().syncActiveSessions()

      // Messages should STILL be preserved even though sync failed
      const session = useAgentStore.getState().sessions.get('task-1')
      expect(session?.messages).toHaveLength(2)
      expect(session?.messages[0].id).toBe('m1')
      expect(session?.messages[1].id).toBe('m2')
    })

    it('clears messages when session ID changes (new/restarted session)', async () => {
      // Pre-populate with old session messages
      setSession('task-1', {
        sessionId: 'old-sess',
        messages: [makeMessage('old-m1'), makeMessage('old-m2')]
      })

      // Server returns a DIFFERENT session ID for the same task
      ;(api.sessions.list as unknown as Mock).mockResolvedValue([
        { sessionId: 'new-sess', agentId: 'agent-1', taskId: 'task-1', status: 'working' }
      ])
      ;(api.sessions.sync as unknown as Mock).mockResolvedValue({ success: true, status: 'working' })

      await useAgentStore.getState().syncActiveSessions()

      // Messages should be CLEARED (new session, full reset)
      const session = useAgentStore.getState().sessions.get('task-1')
      expect(session?.messages).toHaveLength(0)
      expect(session?.sessionId).toBe('new-sess')
    })

    it('creates new session entry when no existing session for task', async () => {
      // No pre-existing session
      ;(api.sessions.list as unknown as Mock).mockResolvedValue([
        { sessionId: 'sess-1', agentId: 'agent-1', taskId: 'task-1', status: 'working' }
      ])
      ;(api.sessions.sync as unknown as Mock).mockResolvedValue({ success: true, status: 'working' })

      await useAgentStore.getState().syncActiveSessions()

      const session = useAgentStore.getState().sessions.get('task-1')
      expect(session).toBeDefined()
      expect(session?.sessionId).toBe('sess-1')
      expect(session?.agentId).toBe('agent-1')
      expect(session?.status).toBe('working')
      expect(session?.messages).toHaveLength(0)
    })

    it('updates status from server while preserving messages on same session', async () => {
      // Session was "working" on client, server reports "waiting_approval"
      setSession('task-1', {
        sessionId: 'sess-1',
        status: 'working',
        messages: [makeMessage('m1')]
      })

      ;(api.sessions.list as unknown as Mock).mockResolvedValue([
        { sessionId: 'sess-1', agentId: 'agent-1', taskId: 'task-1', status: 'waiting_approval' }
      ])
      ;(api.sessions.sync as unknown as Mock).mockResolvedValue({ success: true, status: 'waiting_approval' })

      await useAgentStore.getState().syncActiveSessions()

      const session = useAgentStore.getState().sessions.get('task-1')
      expect(session?.status).toBe('waiting_approval')
      expect(session?.messages).toHaveLength(1)
      expect(session?.messages[0].id).toBe('m1')
    })

    it('does not affect other sessions when syncing active ones', async () => {
      // Two sessions: task-1 is active, task-2 is idle (not returned by server)
      setSession('task-1', {
        sessionId: 'sess-1',
        messages: [makeMessage('m1')]
      })
      setSession('task-2', {
        sessionId: 'sess-2',
        status: 'idle',
        messages: [makeMessage('m2-1'), makeMessage('m2-2')]
      })

      ;(api.sessions.list as unknown as Mock).mockResolvedValue([
        { sessionId: 'sess-1', agentId: 'agent-1', taskId: 'task-1', status: 'working' }
      ])
      ;(api.sessions.sync as unknown as Mock).mockResolvedValue({ success: true, status: 'working' })

      await useAgentStore.getState().syncActiveSessions()

      // task-2 should be completely untouched
      const session2 = useAgentStore.getState().sessions.get('task-2')
      expect(session2?.messages).toHaveLength(2)
      expect(session2?.sessionId).toBe('sess-2')
      expect(session2?.status).toBe('idle')
    })

    it('handles multiple active sessions with mixed same/different IDs', async () => {
      // task-1: same session (reconnect), task-2: different session (restarted)
      setSession('task-1', {
        sessionId: 'sess-1',
        messages: [makeMessage('t1-m1'), makeMessage('t1-m2')]
      })
      setSession('task-2', {
        sessionId: 'old-sess-2',
        messages: [makeMessage('t2-old-m1')]
      })

      ;(api.sessions.list as unknown as Mock).mockResolvedValue([
        { sessionId: 'sess-1', agentId: 'agent-1', taskId: 'task-1', status: 'working' },
        { sessionId: 'new-sess-2', agentId: 'agent-2', taskId: 'task-2', status: 'working' }
      ])
      ;(api.sessions.sync as unknown as Mock).mockResolvedValue({ success: true, status: 'working' })

      await useAgentStore.getState().syncActiveSessions()

      // task-1: same session — messages preserved
      const s1 = useAgentStore.getState().sessions.get('task-1')
      expect(s1?.messages).toHaveLength(2)
      expect(s1?.messages[0].id).toBe('t1-m1')

      // task-2: different session — messages cleared
      const s2 = useAgentStore.getState().sessions.get('task-2')
      expect(s2?.messages).toHaveLength(0)
      expect(s2?.sessionId).toBe('new-sess-2')
    })

    it('handles api.sessions.list failure gracefully', async () => {
      setSession('task-1', {
        sessionId: 'sess-1',
        messages: [makeMessage('m1')]
      })

      ;(api.sessions.list as unknown as Mock).mockRejectedValue(new Error('Server down'))

      await useAgentStore.getState().syncActiveSessions()

      // Messages should be completely untouched
      const session = useAgentStore.getState().sessions.get('task-1')
      expect(session?.messages).toHaveLength(1)
      expect(session?.messages[0].id).toBe('m1')
    })
  })

  describe('initSession', () => {
    it('creates a new session entry', () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')

      const session = useAgentStore.getState().sessions.get('task-1')
      expect(session).toBeDefined()
      expect(session?.sessionId).toBe('sess-1')
      expect(session?.agentId).toBe('agent-1')
      expect(session?.status).toBe('working')
      expect(session?.messages).toHaveLength(0)
    })

    it('preserves existing messages when updating session', () => {
      setSession('task-1', {
        sessionId: 'sess-1',
        messages: [makeMessage('m1')]
      })

      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')

      const session = useAgentStore.getState().sessions.get('task-1')
      expect(session?.messages).toHaveLength(1)
    })
  })

  describe('endSession', () => {
    it('sets session to idle and clears sessionId', () => {
      setSession('task-1', {
        sessionId: 'sess-1',
        status: 'working',
        messages: [makeMessage('m1')]
      })

      useAgentStore.getState().endSession('task-1')

      const session = useAgentStore.getState().sessions.get('task-1')
      expect(session?.sessionId).toBeNull()
      expect(session?.status).toBe('idle')
      expect(session?.messages).toHaveLength(1) // Messages preserved
    })
  })

  describe('removeSession', () => {
    it('removes the session entirely', () => {
      setSession('task-1', { sessionId: 'sess-1' })

      useAgentStore.getState().removeSession('task-1')

      expect(useAgentStore.getState().sessions.get('task-1')).toBeUndefined()
    })
  })

  describe('clearMessageDedup', () => {
    it('clears messages for a task', () => {
      setSession('task-1', {
        sessionId: 'sess-1',
        messages: [makeMessage('m1'), makeMessage('m2')]
      })

      useAgentStore.getState().clearMessageDedup('task-1')

      const session = useAgentStore.getState().sessions.get('task-1')
      expect(session?.messages).toHaveLength(0)
    })
  })
})
