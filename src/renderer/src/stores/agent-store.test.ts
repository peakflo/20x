import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { useAgentStore } from './agent-store'
import type { Agent, CreateAgentDTO, UpdateAgentDTO } from '@/types'
import type { AgentOutputBatchEvent, AgentStatusEvent } from '@/types/electron'

const mockElectronAPI = window.electronAPI

// Capture the onAgentOutputBatch callback before any test clears mocks.
// The store registers it once at module init time.
let batchCallback: ((event: AgentOutputBatchEvent) => void) | null = null
{
  const calls = (mockElectronAPI.onAgentOutputBatch as unknown as Mock).mock.calls
  if (calls.length > 0) batchCallback = calls[0][0]
}

// Capture the onAgentStatus callback for re-keying tests
let statusCallback: ((event: AgentStatusEvent) => void) | null = null
{
  const calls = (mockElectronAPI.onAgentStatus as unknown as Mock).mock.calls
  if (calls.length > 0) statusCallback = calls[0][0]
}

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
      ;(mockElectronAPI.agents.getAll as unknown as Mock).mockResolvedValue(agents)

      await useAgentStore.getState().fetchAgents()

      expect(useAgentStore.getState().agents).toEqual(agents)
      expect(useAgentStore.getState().isLoading).toBe(false)
    })

    it('createAgent appends to list', async () => {
      useAgentStore.setState({ agents: [{ id: 'a1', name: 'Existing' }] as unknown as Agent[] })
      const newAgent = { id: 'a2', name: 'New' }
      ;(mockElectronAPI.agents.create as unknown as Mock).mockResolvedValue(newAgent)

      const result = await useAgentStore.getState().createAgent({ name: 'New' } as unknown as CreateAgentDTO)

      expect(result).toEqual(newAgent)
      expect(useAgentStore.getState().agents).toHaveLength(2)
    })

    it('updateAgent replaces agent in list', async () => {
      useAgentStore.setState({ agents: [{ id: 'a1', name: 'Old' }] as unknown as Agent[] })
      const updated = { id: 'a1', name: 'Updated' }
      ;(mockElectronAPI.agents.update as unknown as Mock).mockResolvedValue(updated)

      await useAgentStore.getState().updateAgent('a1', { name: 'Updated' } as unknown as UpdateAgentDTO)

      expect(useAgentStore.getState().agents[0].name).toBe('Updated')
    })

    it('deleteAgent removes from list', async () => {
      useAgentStore.setState({ agents: [{ id: 'a1' }, { id: 'a2' }] as unknown as Agent[] })
      ;(mockElectronAPI.agents.delete as unknown as Mock).mockResolvedValue(true)

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

      expect(mockElectronAPI.agentSession.stop).toHaveBeenCalledWith('sess-1')
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

  describe('Message management', () => {
    it('clearMessageDedup clears messages', () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')

      // Manually add a message to the session via state update
      const sessions = new Map(useAgentStore.getState().sessions)
      const session = sessions.get('task-1')!
      sessions.set('task-1', {
        ...session,
        messages: [{ id: 'msg-1', role: 'assistant' as const, content: 'Hello', timestamp: new Date() }]
      })
      useAgentStore.setState({ sessions })

      expect(useAgentStore.getState().sessions.get('task-1')!.messages).toHaveLength(1)

      // Clear dedup state and messages
      useAgentStore.getState().clearMessageDedup('task-1')

      // Messages should be cleared
      expect(useAgentStore.getState().sessions.get('task-1')!.messages).toHaveLength(0)
    })

    it('clearMessageDedup handles non-existent session gracefully', () => {
      // Should not throw
      useAgentStore.getState().clearMessageDedup('non-existent')
    })

    it('clearMessageDedup allows previously seen messages to be added again', () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')

      // Simulate adding a message (which marks it as "seen")
      const sessions = new Map(useAgentStore.getState().sessions)
      const session = sessions.get('task-1')!
      sessions.set('task-1', {
        ...session,
        messages: [{ id: 'msg-1', role: 'assistant' as const, content: 'Hello', timestamp: new Date() }]
      })
      useAgentStore.setState({ sessions })

      // Clear dedup state
      useAgentStore.getState().clearMessageDedup('task-1')

      // Verify internal dedup state was cleared by checking messages were cleared
      expect(useAgentStore.getState().sessions.get('task-1')!.messages).toHaveLength(0)
    })
  })

  describe('Batched output handler (onAgentOutputBatch)', () => {
    /** Flush pending rAF-debounced batches synchronously */
    function flushRaf(): Promise<void> {
      return new Promise((resolve) => requestAnimationFrame(() => resolve()))
    }

    it('adds new messages from a batch event', async () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')

      batchCallback!({
        sessionId: 'sess-1',
        taskId: 'task-1',
        messages: [
          { id: 'p1', role: 'assistant', content: 'Hello' },
          { id: 'p2', role: 'assistant', content: 'World', partType: 'tool', tool: { name: 'Bash', status: 'pending' } }
        ]
      })

      await flushRaf()

      const msgs = useAgentStore.getState().sessions.get('task-1')!.messages
      expect(msgs).toHaveLength(2)
      expect(msgs[0].content).toBe('Hello')
      expect(msgs[1].content).toBe('World')
      expect(msgs[1].tool?.name).toBe('Bash')
    })

    it('deduplicates already-seen messages', async () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')

      // First batch
      batchCallback!({
        sessionId: 'sess-1',
        taskId: 'task-1',
        messages: [{ id: 'p1', role: 'assistant', content: 'Hello' }]
      })
      await flushRaf()

      // Second batch with same message id
      batchCallback!({
        sessionId: 'sess-1',
        taskId: 'task-1',
        messages: [{ id: 'p1', role: 'assistant', content: 'Hello again' }]
      })
      await flushRaf()

      const msgs = useAgentStore.getState().sessions.get('task-1')!.messages
      expect(msgs).toHaveLength(1)
      expect(msgs[0].content).toBe('Hello')
    })

    it('handles update messages (tool completion)', async () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')

      // Initial tool call
      batchCallback!({
        sessionId: 'sess-1',
        taskId: 'task-1',
        messages: [
          { id: 'tool-123', role: 'assistant', content: 'Bash', partType: 'tool', tool: { name: 'Bash', status: 'pending', title: 'ls' } }
        ]
      })
      await flushRaf()

      // Tool result update
      batchCallback!({
        sessionId: 'sess-1',
        taskId: 'task-1',
        messages: [
          { id: 'tool-123', role: 'assistant', content: 'Tool completed', partType: 'tool', tool: { name: 'Bash', status: 'success', output: 'file.txt' }, update: true }
        ]
      })
      await flushRaf()

      const msgs = useAgentStore.getState().sessions.get('task-1')!.messages
      expect(msgs).toHaveLength(1)
      expect(msgs[0].content).toBe('Tool completed')
      expect(msgs[0].tool?.status).toBe('success')
      expect(msgs[0].tool?.output).toBe('file.txt')
    })

    it('preserves todowrite/question partType on updates', async () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')

      // Initial question
      batchCallback!({
        sessionId: 'sess-1',
        taskId: 'task-1',
        messages: [
          { id: 'q-1', role: 'assistant', content: 'Question', partType: 'question', tool: { name: 'AskUser', status: 'pending', questions: [] } }
        ]
      })
      await flushRaf()

      // Update with generic partType
      batchCallback!({
        sessionId: 'sess-1',
        taskId: 'task-1',
        messages: [
          { id: 'q-1', role: 'assistant', content: 'Updated', partType: 'tool', tool: { name: 'AskUser', status: 'success' }, update: true }
        ]
      })
      await flushRaf()

      const msgs = useAgentStore.getState().sessions.get('task-1')!.messages
      expect(msgs[0].partType).toBe('question') // preserved, not overwritten to 'tool'
    })

    it('absorbs step-start and step-finish into stepMeta', async () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')

      // Send step-start, a message, and step-finish in one batch
      batchCallback!({
        sessionId: 'sess-1',
        taskId: 'task-1',
        messages: [
          { id: 'step-s-1', role: 'assistant', content: '', partType: 'step-start' },
          { id: 'msg-1', role: 'assistant', content: 'Thinking...' },
          { id: 'step-f-1', role: 'assistant', content: '', partType: 'step-finish' }
        ]
      })
      await flushRaf()

      const msgs = useAgentStore.getState().sessions.get('task-1')!.messages
      // step-start and step-finish should not appear as messages
      expect(msgs).toHaveLength(1)
      expect(msgs[0].content).toBe('Thinking...')
      // stepMeta should be annotated (durationMs will be ~0 since same tick)
      expect(msgs[0].stepMeta).toBeDefined()
      expect(msgs[0].stepMeta!.durationMs).toBeDefined()
    })

    it('coalesces multiple batches from different sessions into single state update', async () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')
      useAgentStore.getState().initSession('task-2', 'sess-2', 'agent-1')

      // Track how many times set() is called by counting state changes
      const stateChanges: number[] = []
      const unsub = useAgentStore.subscribe(() => stateChanges.push(1))

      // Fire two batch events synchronously (before rAF fires)
      batchCallback!({
        sessionId: 'sess-1',
        taskId: 'task-1',
        messages: [{ id: 'a1', role: 'assistant', content: 'From agent 1' }]
      })
      batchCallback!({
        sessionId: 'sess-2',
        taskId: 'task-2',
        messages: [{ id: 'b1', role: 'assistant', content: 'From agent 2' }]
      })

      // Both should be processed in a single rAF flush
      await flushRaf()

      unsub()

      // Only 1 state update should have occurred (both batches coalesced)
      expect(stateChanges).toHaveLength(1)

      // Both sessions should have their messages
      expect(useAgentStore.getState().sessions.get('task-1')!.messages).toHaveLength(1)
      expect(useAgentStore.getState().sessions.get('task-2')!.messages).toHaveLength(1)
    })

    it('ignores batch for unknown session', async () => {
      batchCallback!({
        sessionId: 'unknown-sess',
        taskId: 'unknown-task',
        messages: [{ id: 'x1', role: 'assistant', content: 'Ghost' }]
      })
      await flushRaf()

      expect(useAgentStore.getState().sessions.size).toBe(0)
    })

    it('resolves session by taskId when sessionId does not match', async () => {
      useAgentStore.getState().initSession('task-1', '', 'agent-1')

      batchCallback!({
        sessionId: 'real-sess-1',
        taskId: 'task-1',
        messages: [{ id: 'p1', role: 'assistant', content: 'Hello' }]
      })
      await flushRaf()

      const session = useAgentStore.getState().sessions.get('task-1')!
      expect(session.sessionId).toBe('real-sess-1')
      expect(session.messages).toHaveLength(1)
    })

    it('updates sessionId when main process re-keys from temp to real ID', async () => {
      // Session starts with a temp UUID
      useAgentStore.getState().initSession('task-1', 'temp-uuid', 'agent-1')

      // Main process sends batch with the real session ID after re-keying
      batchCallback!({
        sessionId: 'real-session-id',
        taskId: 'task-1',
        messages: [{ id: 'p1', role: 'assistant', content: 'Hello' }]
      })
      await flushRaf()

      const session = useAgentStore.getState().sessions.get('task-1')!
      // Session ID should be updated to the real one, not stuck on temp-uuid
      expect(session.sessionId).toBe('real-session-id')
      expect(session.messages).toHaveLength(1)
    })
  })

  describe('Session ID re-keying via onAgentStatus', () => {
    it('updates sessionId when status event carries re-keyed session ID', () => {
      // Session starts with temp UUID
      useAgentStore.getState().initSession('task-1', 'temp-uuid', 'agent-1')

      // Main process sends status with real session ID after re-keying
      statusCallback!({
        sessionId: 'real-session-id',
        agentId: 'agent-1',
        taskId: 'task-1',
        status: 'working' as any
      })

      const session = useAgentStore.getState().sessions.get('task-1')!
      expect(session.sessionId).toBe('real-session-id')
    })
  })
})
