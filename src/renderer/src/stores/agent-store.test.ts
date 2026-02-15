import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useAgentStore } from './agent-store'

const mockElectronAPI = window.electronAPI

beforeEach(() => {
  useAgentStore.setState({
    agents: [],
    isLoading: false,
    error: null,
    sessions: new Map()
  })
  vi.clearAllMocks()
})

describe('useAgentStore', () => {
  describe('Agent CRUD', () => {
    it('fetchAgents sets agents', async () => {
      const agents = [{ id: 'a1', name: 'Agent 1' }]
      ;(mockElectronAPI.agents.getAll as any).mockResolvedValue(agents)

      await useAgentStore.getState().fetchAgents()

      expect(useAgentStore.getState().agents).toEqual(agents)
      expect(useAgentStore.getState().isLoading).toBe(false)
    })

    it('createAgent appends to list', async () => {
      useAgentStore.setState({ agents: [{ id: 'a1', name: 'Existing' }] as any })
      const newAgent = { id: 'a2', name: 'New' }
      ;(mockElectronAPI.agents.create as any).mockResolvedValue(newAgent)

      const result = await useAgentStore.getState().createAgent({ name: 'New' } as any)

      expect(result).toEqual(newAgent)
      expect(useAgentStore.getState().agents).toHaveLength(2)
    })

    it('updateAgent replaces agent in list', async () => {
      useAgentStore.setState({ agents: [{ id: 'a1', name: 'Old' }] as any })
      const updated = { id: 'a1', name: 'Updated' }
      ;(mockElectronAPI.agents.update as any).mockResolvedValue(updated)

      await useAgentStore.getState().updateAgent('a1', { name: 'Updated' } as any)

      expect(useAgentStore.getState().agents[0].name).toBe('Updated')
    })

    it('deleteAgent removes from list', async () => {
      useAgentStore.setState({ agents: [{ id: 'a1' }, { id: 'a2' }] as any })
      ;(mockElectronAPI.agents.delete as any).mockResolvedValue(true)

      const result = await useAgentStore.getState().deleteAgent('a1')

      expect(result).toBe(true)
      expect(useAgentStore.getState().agents).toHaveLength(1)
    })
  })

  describe('Session lifecycle', () => {
    it('initSession creates a new session', () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')

      const session = useAgentStore.getState().sessions.get('task-1')
      expect(session).toBeDefined()
      expect(session!.sessionId).toBe('sess-1')
      expect(session!.agentId).toBe('agent-1')
      expect(session!.status).toBe('working')
      expect(session!.messages).toEqual([])
    })

    it('initSession preserves existing messages', () => {
      useAgentStore.getState().initSession('task-1', '', 'agent-1')
      // Simulate adding a message
      const sessions = new Map(useAgentStore.getState().sessions)
      const session = sessions.get('task-1')!
      sessions.set('task-1', {
        ...session,
        messages: [{ id: 'msg-1', role: 'assistant' as const, content: 'Hello', timestamp: new Date() }]
      })
      useAgentStore.setState({ sessions })

      // Update with real sessionId
      useAgentStore.getState().initSession('task-1', 'real-sess', 'agent-1')

      const updated = useAgentStore.getState().sessions.get('task-1')!
      expect(updated.sessionId).toBe('real-sess')
      expect(updated.messages).toHaveLength(1)
    })

    it('endSession sets idle and clears sessionId', () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')
      useAgentStore.getState().endSession('task-1')

      const session = useAgentStore.getState().sessions.get('task-1')!
      expect(session.sessionId).toBeNull()
      expect(session.status).toBe('idle')
      expect(session.pendingApproval).toBeNull()
    })

    it('removeSession deletes session entirely', () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')
      useAgentStore.getState().removeSession('task-1')

      expect(useAgentStore.getState().sessions.has('task-1')).toBe(false)
    })

    it('stopAndRemoveSessionForTask stops and removes', async () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')

      await useAgentStore.getState().stopAndRemoveSessionForTask('task-1')

      expect(mockElectronAPI.agentSession.stop).toHaveBeenCalledWith('sess-1', false)
      expect(useAgentStore.getState().sessions.has('task-1')).toBe(false)
    })

    it('stopAndRemoveSessionForTask handles missing session gracefully', async () => {
      await useAgentStore.getState().stopAndRemoveSessionForTask('non-existent')
      // Should not throw
    })
  })

  describe('getSession', () => {
    it('returns session for existing task', () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')
      const session = useAgentStore.getState().getSession('task-1')
      expect(session).toBeDefined()
      expect(session!.sessionId).toBe('sess-1')
    })

    it('returns undefined for non-existent task', () => {
      expect(useAgentStore.getState().getSession('nope')).toBeUndefined()
    })
  })
})
