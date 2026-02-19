import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAgentSession } from './use-agent-session'
import { useAgentStore } from '@/stores/agent-store'

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

describe('useAgentSession', () => {
  it('returns empty session state when no taskId', () => {
    const { result } = renderHook(() => useAgentSession(undefined))

    expect(result.current.session.sessionId).toBeNull()
    expect(result.current.session.status).toBe('idle')
    expect(result.current.session.messages).toEqual([])
    expect(result.current.session.pendingApproval).toBeNull()
  })

  it('returns empty session state when taskId has no session', () => {
    const { result } = renderHook(() => useAgentSession('task-1'))

    expect(result.current.session.status).toBe('idle')
  })

  describe('start', () => {
    it('pre-registers then updates with real sessionId', async () => {
      ;(mockElectronAPI.agentSession.start as any).mockResolvedValue({
        sessionId: 'real-session-id'
      })

      const { result } = renderHook(() => useAgentSession('task-1'))

      let sessionId: string = ''
      await act(async () => {
        sessionId = await result.current.start('agent-1', 'task-1')
      })

      expect(sessionId).toBe('real-session-id')
      expect(mockElectronAPI.agentSession.start).toHaveBeenCalledWith('agent-1', 'task-1', undefined, undefined)

      // Session should be in the store
      const session = useAgentStore.getState().sessions.get('task-1')
      expect(session).toBeDefined()
      expect(session!.sessionId).toBe('real-session-id')
    })
  })

  describe('abort', () => {
    it('calls agentSession.abort', async () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')

      const { result } = renderHook(() => useAgentSession('task-1'))

      await act(async () => {
        await result.current.abort()
      })

      expect(mockElectronAPI.agentSession.abort).toHaveBeenCalledWith('sess-1')
    })

    it('does nothing without sessionId', async () => {
      const { result } = renderHook(() => useAgentSession('task-1'))

      await act(async () => {
        await result.current.abort()
      })

      expect(mockElectronAPI.agentSession.abort).not.toHaveBeenCalled()
    })

    it('uses latest sessionId from store', async () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')
      const { result } = renderHook(() => useAgentSession('task-1'))

      // Update sessionId in store
      act(() => {
        useAgentStore.getState().initSession('task-1', 'sess-updated', 'agent-1')
      })

      await act(async () => {
        await result.current.abort()
      })

      expect(mockElectronAPI.agentSession.abort).toHaveBeenCalledWith('sess-updated')
    })
  })

  describe('stop', () => {
    it('stops session and ends it in store', async () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')

      const { result } = renderHook(() => useAgentSession('task-1'))

      await act(async () => {
        await result.current.stop()
      })

      expect(mockElectronAPI.agentSession.stop).toHaveBeenCalledWith('sess-1')
      const session = useAgentStore.getState().sessions.get('task-1')
      expect(session!.status).toBe('idle')
      expect(session!.sessionId).toBeNull()
    })

    it('uses latest sessionId from store', async () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')
      const { result } = renderHook(() => useAgentSession('task-1'))

      // Update sessionId in store
      act(() => {
        useAgentStore.getState().initSession('task-1', 'sess-updated', 'agent-1')
      })

      await act(async () => {
        await result.current.stop()
      })

      expect(mockElectronAPI.agentSession.stop).toHaveBeenCalledWith('sess-updated')
    })
  })

  describe('sendMessage', () => {
    it('sends message to active session', async () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')

      const { result } = renderHook(() => useAgentSession('task-1'))

      await act(async () => {
        await result.current.sendMessage('Hello agent')
      })

      expect(mockElectronAPI.agentSession.send).toHaveBeenCalledWith('sess-1', 'Hello agent', 'task-1')
    })

    it('throws when no active session', async () => {
      const { result } = renderHook(() => useAgentSession('task-1'))

      await expect(
        act(async () => {
          await result.current.sendMessage('Hello')
        })
      ).rejects.toThrow('No active session')
    })

    it('uses latest sessionId from store, not stale closure', async () => {
      // Initialize with first sessionId
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')

      const { result } = renderHook(() => useAgentSession('task-1'))

      // Simulate session being resumed with new sessionId (like after resume)
      act(() => {
        useAgentStore.getState().initSession('task-1', 'sess-2-new', 'agent-1')
      })

      // Mock the send to return a new sessionId
      ;(mockElectronAPI.agentSession.send as any).mockResolvedValue({
        newSessionId: 'sess-2-new'
      })

      await act(async () => {
        await result.current.sendMessage('After resume')
      })

      // Should use the NEW sessionId from store, not the old one from closure
      expect(mockElectronAPI.agentSession.send).toHaveBeenCalledWith('sess-2-new', 'After resume', 'task-1')
    })
  })

  describe('approve', () => {
    it('sends approval to active session', async () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')

      const { result } = renderHook(() => useAgentSession('task-1'))

      await act(async () => {
        await result.current.approve(true, 'looks good')
      })

      expect(mockElectronAPI.agentSession.approve).toHaveBeenCalledWith('sess-1', true, 'looks good')
    })

    it('throws when no active session', async () => {
      const { result } = renderHook(() => useAgentSession('task-1'))

      await expect(
        act(async () => {
          await result.current.approve(false)
        })
      ).rejects.toThrow('No active session')
    })

    it('uses latest sessionId from store', async () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')
      const { result } = renderHook(() => useAgentSession('task-1'))

      // Update sessionId in store
      act(() => {
        useAgentStore.getState().initSession('task-1', 'sess-updated', 'agent-1')
      })

      await act(async () => {
        await result.current.approve(true, 'approved')
      })

      expect(mockElectronAPI.agentSession.approve).toHaveBeenCalledWith('sess-updated', true, 'approved')
    })
  })
})
