import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { captureAnalyticsEvent } from '@/lib/analytics'
import { useAgentStore, SessionStatus, __clearProjectionsForTest } from './agent-store'
import type { Agent, CreateAgentDTO, UpdateAgentDTO } from '@/types'
import type { AgentStatusEvent, TranscriptPartRecord, TranscriptChangedEvent } from '@/types/electron'

vi.mock('@/lib/analytics', () => ({
  captureAnalyticsEvent: vi.fn()
}))

const mockElectronAPI = window.electronAPI

// Capture the store's IPC subscriptions registered once at module init.
function firstCb<T>(fn: unknown): T | null {
  const calls = (fn as Mock).mock.calls
  return calls.length > 0 ? (calls[0][0] as T) : null
}
const transcriptCb = firstCb<(e: TranscriptChangedEvent) => void>(mockElectronAPI.onTranscriptChanged)
const statusCallback = firstCb<(e: AgentStatusEvent) => void>(mockElectronAPI.onAgentStatus)

const getSnapshotMock = mockElectronAPI.agentSession.getTranscriptSnapshot as unknown as Mock
const getDeltaMock = mockElectronAPI.agentSession.getTranscriptDelta as unknown as Mock

let partSeq = 0
function part(overrides: Partial<TranscriptPartRecord> & { partId: string }): TranscriptPartRecord {
  partSeq += 1
  return {
    taskId: 'task-1',
    partId: overrides.partId,
    seq: overrides.seq ?? partSeq,
    role: overrides.role ?? 'assistant',
    content: overrides.content ?? '',
    partType: overrides.partType ?? 'text',
    tool: overrides.tool,
    payload: overrides.payload,
    createdAt: overrides.createdAt ?? 1000 + partSeq,
    updatedAt: overrides.updatedAt ?? 1000 + partSeq,
    rev: overrides.rev ?? partSeq
  }
}

function fireDelta(taskId: string, parts: TranscriptPartRecord[], maxRev?: number): void {
  transcriptCb!({ taskId, parts, maxRev: maxRev ?? Math.max(0, ...parts.map((p) => p.rev)) })
}

beforeEach(() => {
  useAgentStore.setState({ agents: [], isLoading: false, error: null, sessions: new Map() })
  __clearProjectionsForTest()
  vi.clearAllMocks()
  getSnapshotMock.mockResolvedValue([])
  getDeltaMock.mockResolvedValue({ parts: [], maxRev: 0 })
  partSeq = 0
})

describe('useAgentStore', () => {
  describe('Agent CRUD', () => {
    it('fetchAgents sets agents', async () => {
      const agents = [{ id: 'a1', name: 'Agent 1' }] as unknown as Agent[]
      ;(mockElectronAPI.agents.getAll as unknown as Mock).mockResolvedValue(agents)
      await useAgentStore.getState().fetchAgents()
      expect(useAgentStore.getState().agents).toEqual(agents)
    })

    it('createAgent appends to list', async () => {
      const agent = { id: 'a1', name: 'New' } as unknown as Agent
      ;(mockElectronAPI.agents.create as unknown as Mock).mockResolvedValue(agent)
      await useAgentStore.getState().createAgent({} as CreateAgentDTO)
      expect(useAgentStore.getState().agents).toContainEqual(agent)
    })

    it('updateAgent replaces agent in list', async () => {
      useAgentStore.setState({ agents: [{ id: 'a1', name: 'Old' } as unknown as Agent] })
      const updated = { id: 'a1', name: 'New' } as unknown as Agent
      ;(mockElectronAPI.agents.update as unknown as Mock).mockResolvedValue(updated)
      await useAgentStore.getState().updateAgent('a1', {} as UpdateAgentDTO)
      expect(useAgentStore.getState().agents[0].name).toBe('New')
    })

    it('deleteAgent removes from list', async () => {
      useAgentStore.setState({ agents: [{ id: 'a1', name: 'X' } as unknown as Agent] })
      ;(mockElectronAPI.agents.delete as unknown as Mock).mockResolvedValue(true)
      await useAgentStore.getState().deleteAgent('a1')
      expect(useAgentStore.getState().agents).toHaveLength(0)
    })
  })

  describe('Session lifecycle', () => {
    it('initSession creates a new session', () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')
      const s = useAgentStore.getState().sessions.get('task-1')
      expect(s?.sessionId).toBe('sess-1')
      expect(s?.agentId).toBe('agent-1')
    })

    it('endSession sets idle and clears sessionId', () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')
      useAgentStore.getState().endSession('task-1')
      const s = useAgentStore.getState().sessions.get('task-1')
      expect(s?.sessionId).toBeNull()
      expect(s?.status).toBe(SessionStatus.IDLE)
    })

    it('removeSession deletes session entirely', () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')
      useAgentStore.getState().removeSession('task-1')
      expect(useAgentStore.getState().sessions.has('task-1')).toBe(false)
    })

    it('stopAndRemoveSessionForTask stops and removes', async () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')
      ;(mockElectronAPI.agentSession.stop as unknown as Mock).mockResolvedValue({ success: true })
      await useAgentStore.getState().stopAndRemoveSessionForTask('task-1')
      expect(useAgentStore.getState().sessions.has('task-1')).toBe(false)
    })

    it('stopAndRemoveSessionForTask handles missing session gracefully', async () => {
      await expect(useAgentStore.getState().stopAndRemoveSessionForTask('nope')).resolves.toBeUndefined()
    })
  })

  describe('getSession', () => {
    it('returns session for existing task', () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')
      expect(useAgentStore.getState().getSession('task-1')?.sessionId).toBe('sess-1')
    })
    it('returns undefined for non-existent task', () => {
      expect(useAgentStore.getState().getSession('nope')).toBeUndefined()
    })
  })

  describe('Transcript projection (transcript:changed deltas)', () => {
    it('renders parts from a delta, sorted by createdAt', () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')
      fireDelta('task-1', [
        part({ partId: 'p1', role: 'user', content: 'hello', createdAt: 100 }),
        part({ partId: 'p2', role: 'assistant', content: 'hi', createdAt: 200 })
      ])
      const msgs = useAgentStore.getState().sessions.get('task-1')!.messages
      expect(msgs.map((m) => m.id)).toEqual(['p1', 'p2'])
      expect(msgs.map((m) => m.content)).toEqual(['hello', 'hi'])
    })

    it('is idempotent — the same delta applied twice does not duplicate', () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')
      const d = [part({ partId: 'p1', content: 'x', createdAt: 100 })]
      fireDelta('task-1', d)
      fireDelta('task-1', d)
      expect(useAgentStore.getState().sessions.get('task-1')!.messages).toHaveLength(1)
    })

    it('content update to an existing part replaces in place (no new row, same position)', () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')
      fireDelta('task-1', [
        part({ partId: 'p1', content: 'partial', createdAt: 100, rev: 1 }),
        part({ partId: 'p2', content: 'after', createdAt: 200, rev: 2 })
      ])
      // streaming update: same partId, later rev, SAME createdAt (position stable)
      fireDelta('task-1', [part({ partId: 'p1', content: 'partial then complete', createdAt: 100, rev: 3 })])
      const msgs = useAgentStore.getState().sessions.get('task-1')!.messages
      expect(msgs.map((m) => m.id)).toEqual(['p1', 'p2'])
      expect(msgs[0].content).toBe('partial then complete')
    })

    it('two legitimately-identical messages under different ids both render (id-keyed, never content-collapsed)', () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')
      fireDelta('task-1', [
        part({ partId: 'u1', role: 'user', content: 'run it again', createdAt: 100 }),
        part({ partId: 'u2', role: 'user', content: 'run it again', createdAt: 200 })
      ])
      expect(useAgentStore.getState().sessions.get('task-1')!.messages.filter((m) => m.content === 'run it again')).toHaveLength(2)
    })

    it('out-of-order deltas converge to chronological order', () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')
      fireDelta('task-1', [part({ partId: 'p2', content: 'second', createdAt: 200 })])
      fireDelta('task-1', [part({ partId: 'p1', content: 'first', createdAt: 100 })])
      expect(useAgentStore.getState().sessions.get('task-1')!.messages.map((m) => m.id)).toEqual(['p1', 'p2'])
    })

    it('reconstructs tool + taskProgress from the part', () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')
      fireDelta('task-1', [
        part({ partId: 't1', partType: 'tool', content: '', tool: { name: 'Bash', status: 'success' } as never }),
        part({ partId: 'tp1', partType: 'task_progress', content: '', payload: { taskProgress: { taskId: 'x', status: 'running', description: 'go' } } })
      ])
      const msgs = useAgentStore.getState().sessions.get('task-1')!.messages
      expect(msgs.find((m) => m.id === 't1')!.tool?.name).toBe('Bash')
      expect(msgs.find((m) => m.id === 'tp1')!.taskProgress?.status).toBe('running')
    })

    it('batches output analytics until the task goes idle', () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')

      fireDelta('task-1', [
        part({ partId: 'p1', content: 'one', rev: 1 }),
        part({ partId: 't1', partType: 'tool', content: '', tool: { name: 'Bash', status: 'success' } as never, rev: 2 })
      ], 2)
      fireDelta('task-1', [
        part({ partId: 't2', partType: 'tool', content: '', tool: { name: 'Read', status: 'success' } as never, rev: 3 })
      ], 3)

      expect(captureAnalyticsEvent).not.toHaveBeenCalledWith('agent_output_batch_received', expect.anything())

      statusCallback!({ sessionId: 'sess-1', agentId: 'agent-1', taskId: 'task-1', status: SessionStatus.IDLE })

      expect(captureAnalyticsEvent).toHaveBeenCalledWith('agent_output_batch_received', {
        task_id: 'task-1',
        agent_id: 'agent-1',
        session_id: 'sess-1',
        message_count: 3,
        tool_names: ['Bash', 'Read']
      })
      expect(captureAnalyticsEvent).toHaveBeenCalledTimes(2)

      statusCallback!({ sessionId: 'sess-1', agentId: 'agent-1', taskId: 'task-1', status: SessionStatus.IDLE })
      expect(captureAnalyticsEvent).toHaveBeenCalledTimes(2)
    })
  })

  describe('hydrateTranscript (snapshot bind)', () => {
    it('loads the full snapshot into messages', async () => {
      getSnapshotMock.mockResolvedValue([
        part({ partId: 'p1', role: 'user', content: 'q', createdAt: 100 }),
        part({ partId: 'p2', role: 'assistant', content: 'a', createdAt: 200 })
      ])
      await useAgentStore.getState().hydrateTranscript('task-1')
      const msgs = useAgentStore.getState().sessions.get('task-1')!.messages
      expect(msgs.map((m) => m.id)).toEqual(['p1', 'p2'])
    })

    it('empty snapshot leaves no session', async () => {
      getSnapshotMock.mockResolvedValue([])
      await useAgentStore.getState().hydrateTranscript('task-x')
      expect(useAgentStore.getState().sessions.has('task-x')).toBe(false)
    })

    it('a delta after hydrate appends, keeping earlier messages', async () => {
      getSnapshotMock.mockResolvedValue([part({ partId: 'p1', content: 'one', createdAt: 100, rev: 1 })])
      await useAgentStore.getState().hydrateTranscript('task-1')
      fireDelta('task-1', [part({ partId: 'p2', content: 'two', createdAt: 200, rev: 2 })])
      expect(useAgentStore.getState().sessions.get('task-1')!.messages.map((m) => m.id)).toEqual(['p1', 'p2'])
    })

    it('releases an unmounted transcript and ignores background deltas until rebound', async () => {
      getSnapshotMock.mockResolvedValue([part({ partId: 'p1', content: 'large history', rev: 1 })])
      const release = useAgentStore.getState().bindTranscript('task-1')
      await vi.waitFor(() => {
        expect(useAgentStore.getState().sessions.get('task-1')?.messages).toHaveLength(1)
      })

      release()
      expect(useAgentStore.getState().sessions.get('task-1')?.messages).toEqual([])

      fireDelta('task-1', [part({ partId: 'p2', content: 'background output', rev: 2 })])
      expect(useAgentStore.getState().sessions.get('task-1')?.messages).toEqual([])
    })

    it('keeps the projection until the final mounted consumer releases it', async () => {
      getSnapshotMock.mockResolvedValue([part({ partId: 'p1', content: 'shared history' })])
      const releaseFirst = useAgentStore.getState().bindTranscript('task-1')
      const releaseSecond = useAgentStore.getState().bindTranscript('task-1')
      await vi.waitFor(() => {
        expect(useAgentStore.getState().sessions.get('task-1')?.messages).toHaveLength(1)
      })

      releaseFirst()
      expect(useAgentStore.getState().sessions.get('task-1')?.messages).toHaveLength(1)
      releaseSecond()
      expect(useAgentStore.getState().sessions.get('task-1')?.messages).toEqual([])
    })

    it('rehydrates the authoritative transcript when a released view mounts again', async () => {
      getSnapshotMock.mockResolvedValueOnce([part({ partId: 'p1', content: 'first view', rev: 1 })])
      const release = useAgentStore.getState().bindTranscript('task-1')
      await vi.waitFor(() => {
        expect(useAgentStore.getState().sessions.get('task-1')?.messages).toHaveLength(1)
      })
      release()

      getSnapshotMock.mockResolvedValueOnce([
        part({ partId: 'p1', content: 'first view', rev: 1 }),
        part({ partId: 'p2', content: 'background output', rev: 2 })
      ])
      const releaseAgain = useAgentStore.getState().bindTranscript('task-1')
      await vi.waitFor(() => {
        expect(useAgentStore.getState().sessions.get('task-1')?.messages.map((message) => message.id)).toEqual([
          'p1',
          'p2'
        ])
      })
      releaseAgain()
    })
  })

  describe('Session status via onAgentStatus (state only, not messages)', () => {
    it('updates status and sessionId (re-key)', () => {
      useAgentStore.getState().initSession('task-1', 'temp', 'agent-1')
      statusCallback!({ sessionId: 'temp', agentId: 'agent-1', taskId: 'task-1', status: SessionStatus.WORKING })
      statusCallback!({ sessionId: 'real', agentId: 'agent-1', taskId: 'task-1', status: SessionStatus.WORKING } as AgentStatusEvent)
      // re-key: status arrives with a new sessionId but same taskId
      const s = useAgentStore.getState().sessions.get('task-1')!
      expect(s.status).toBe(SessionStatus.WORKING)
    })

    it('auto-creates a session for a remote working status', () => {
      statusCallback!({ sessionId: 'sess-r', agentId: 'agent-1', taskId: 'task-remote', status: SessionStatus.WORKING })
      expect(useAgentStore.getState().sessions.get('task-remote')?.sessionId).toBe('sess-r')
    })

    it('does NOT create a phantom session for a remote idle status', () => {
      statusCallback!({ sessionId: 'sess-r', agentId: 'agent-1', taskId: 'task-idle', status: SessionStatus.IDLE })
      // idle for an unknown task triggers a bind (snapshot empty) but no phantom session
      expect(useAgentStore.getState().sessions.has('task-idle')).toBe(false)
    })

    it('clears pendingApproval on idle', () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')
      useAgentStore.setState((st) => ({
        sessions: new Map(st.sessions).set('task-1', { ...st.sessions.get('task-1')!, pendingApproval: { sessionId: 'sess-1', action: 'x', description: 'y' } })
      }))
      statusCallback!({ sessionId: 'sess-1', agentId: 'agent-1', taskId: 'task-1', status: SessionStatus.IDLE })
      expect(useAgentStore.getState().sessions.get('task-1')!.pendingApproval).toBeNull()
    })
  })

  describe('pendingSend (starting indicator during resume)', () => {
    beforeEach(() => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')
      useAgentStore.getState().endSession('task-1') // back to idle, keeps the session
    })

    it('beginSend sets pendingSend', () => {
      useAgentStore.getState().beginSend('task-1')
      expect(useAgentStore.getState().sessions.get('task-1')!.pendingSend).toBe(true)
    })

    it('an interim IDLE status during resume does NOT clear pendingSend', () => {
      useAgentStore.getState().beginSend('task-1')
      statusCallback!({ sessionId: 'sess-1', agentId: 'agent-1', taskId: 'task-1', status: SessionStatus.IDLE })
      expect(useAgentStore.getState().sessions.get('task-1')!.pendingSend).toBe(true)
    })

    it('a WORKING status clears pendingSend (turn confirmed)', () => {
      useAgentStore.getState().beginSend('task-1')
      statusCallback!({ sessionId: 'sess-1', agentId: 'agent-1', taskId: 'task-1', status: SessionStatus.WORKING })
      expect(useAgentStore.getState().sessions.get('task-1')!.pendingSend).toBe(false)
    })

    it('endSend clears pendingSend (e.g. send failed)', () => {
      useAgentStore.getState().beginSend('task-1')
      useAgentStore.getState().endSend('task-1')
      expect(useAgentStore.getState().sessions.get('task-1')!.pendingSend).toBe(false)
    })
  })

  describe('scenario: send-after-restart never loses history (the regression)', () => {
    it('binds a long history on restart, then a send delta appends without dropping anything', async () => {
      // Restart: bind a large existing transcript from the projection snapshot.
      const history = Array.from({ length: 200 }, (_, i) =>
        part({ partId: `h${i}`, role: i % 2 ? 'assistant' : 'user', content: `m${i}`, createdAt: 1000 + i, rev: i + 1 })
      )
      getSnapshotMock.mockResolvedValue(history)
      await useAgentStore.getState().hydrateTranscript('task-1')
      expect(useAgentStore.getState().sessions.get('task-1')!.messages).toHaveLength(200)

      // Send: user echo + assistant reply arrive as a delta (higher createdAt/rev).
      fireDelta('task-1', [
        part({ partId: 'u-new', role: 'user', content: 'new message', createdAt: 2000, rev: 300 }),
        part({ partId: 'a-new', role: 'assistant', content: 'reply', createdAt: 2001, rev: 301 })
      ])

      const msgs = useAgentStore.getState().sessions.get('task-1')!.messages
      expect(msgs).toHaveLength(202) // full history + 2, nothing lost or collapsed
      expect(msgs[0].id).toBe('h0')
      expect(msgs[msgs.length - 1].id).toBe('a-new')
      expect(msgs[msgs.length - 2].id).toBe('u-new')
    })
  })

  describe('clearMessageDedup (no-op in projection model)', () => {
    it('does not throw and does not wipe the projection', () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')
      fireDelta('task-1', [part({ partId: 'p1', content: 'x' })])
      useAgentStore.getState().clearMessageDedup('task-1')
      expect(useAgentStore.getState().sessions.get('task-1')!.messages).toHaveLength(1)
    })
  })
})
