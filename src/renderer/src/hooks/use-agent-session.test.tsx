import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAgentSession } from './use-agent-session'
import { useAgentStore } from '@/stores/agent-store'
import { useTaskStore } from '@/stores/task-store'
import type { WorkfloTask } from '@/types'

const mockElectronAPI = window.electronAPI

beforeEach(() => {
  useAgentStore.setState({
    agents: [],
    isLoading: false,
    error: null,
    sessions: new Map()
  })
  useTaskStore.setState({ tasks: [] })
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
    it('opens Cursor install setup on a missing CLI and leaves the task retryable', async () => {
      ;(mockElectronAPI.agentSession.start as unknown as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('CURSOR_CLI_MISSING: cursor-agent is not installed'))
        .mockResolvedValueOnce({ sessionId: 'retry-session' })
      const onMissing = vi.fn()
      window.addEventListener('cursor-cli-missing', onMissing)
      const { result } = renderHook(() => useAgentSession('task-1'))
      try {
        await act(async () => {
          await expect(result.current.start('agent-1', 'task-1')).rejects.toThrow('CURSOR_CLI_MISSING')
        })
        expect(useAgentStore.getState().sessions.has('task-1')).toBe(false)
        expect(onMissing).toHaveBeenCalledOnce()
        const retry = (onMissing.mock.calls[0][0] as CustomEvent<{ retry: () => Promise<string> }>).detail.retry
        await act(async () => { await expect(retry()).resolves.toBe('retry-session') })
      } finally {
        window.removeEventListener('cursor-cli-missing', onMissing)
      }
    })

    it('pre-registers then updates with real sessionId', async () => {
      ;(mockElectronAPI.agentSession.start as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
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

  describe('resume', () => {
    it('opens Cursor install setup, clears the failed binding, preserves messages, and retries resume', async () => {
      useTaskStore.setState({ tasks: [{ id: 'task-1', title: 'Review crash' } as WorkfloTask] })
      useAgentStore.getState().initSession('task-1', 'persisted-session', 'agent-1')
      const existing = useAgentStore.getState().sessions.get('task-1')!
      const previousMessages = [{ id: 'old', role: 'assistant' as const, content: 'Previous answer', timestamp: new Date() }]
      useAgentStore.setState({ sessions: new Map([['task-1', { ...existing, messages: previousMessages }]]) })
      ;(mockElectronAPI.agentSession.resume as unknown as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('CURSOR_CLI_MISSING: cursor-agent is not installed'))
        .mockResolvedValueOnce({ sessionId: 'resumed-session' })
      const onMissing = vi.fn()
      window.addEventListener('cursor-cli-missing', onMissing)
      const { result } = renderHook(() => useAgentSession('task-1'))
      try {
        await act(async () => {
          await expect(result.current.resume('agent-1', 'task-1', 'persisted-session')).rejects.toThrow('CURSOR_CLI_MISSING')
        })
        expect(onMissing).toHaveBeenCalledOnce()
        const failed = useAgentStore.getState().sessions.get('task-1')
        expect(failed?.sessionId).toBeNull()
        expect(failed?.messages).toEqual(previousMessages)
        const detail = (onMissing.mock.calls[0][0] as CustomEvent<{
          taskId: string; taskTitle: string; operation: string; retry: () => Promise<string>
        }>).detail
        expect(detail).toMatchObject({ taskId: 'task-1', taskTitle: 'Review crash', operation: 'resume' })
        await act(async () => { await expect(detail.retry()).resolves.toBe('resumed-session') })
        expect(mockElectronAPI.agentSession.resume).toHaveBeenLastCalledWith('agent-1', 'task-1', 'persisted-session')
      } finally {
        window.removeEventListener('cursor-cli-missing', onMissing)
      }
    })

    it('clears a failed binding without opening Cursor setup for other resume errors', async () => {
      ;(mockElectronAPI.agentSession.resume as unknown as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('Provider unavailable'))
      const onMissing = vi.fn()
      window.addEventListener('cursor-cli-missing', onMissing)
      const { result } = renderHook(() => useAgentSession('task-1'))
      try {
        await act(async () => {
          await expect(result.current.resume('agent-1', 'task-1', 'persisted-session')).rejects.toThrow('Provider unavailable')
        })
        expect(useAgentStore.getState().sessions.get('task-1')?.sessionId).toBeNull()
        expect(onMissing).not.toHaveBeenCalled()
      } finally {
        window.removeEventListener('cursor-cli-missing', onMissing)
      }
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

      expect(mockElectronAPI.agentSession.send).toHaveBeenCalledWith('sess-1', 'Hello agent', 'task-1', 'agent-1', undefined)
    })

    it('sends message attachments when provided', async () => {
      useAgentStore.getState().initSession('task-1', 'sess-1', 'agent-1')

      const { result } = renderHook(() => useAgentSession('task-1'))
      const attachments = [{ id: 'a-1', filename: 'notes.md', size: 128, mime_type: 'text/markdown' }]

      await act(async () => {
        await result.current.sendMessage('Use this file', { attachments })
      })

      expect(mockElectronAPI.agentSession.send).toHaveBeenCalledWith('sess-1', 'Use this file', 'task-1', 'agent-1', attachments)
    })

    it('falls back to sendByTaskId when no active session', async () => {
      const { result } = renderHook(() => useAgentSession('task-1'))

      await act(async () => {
        await result.current.sendMessage('Hello')
      })

      expect(mockElectronAPI.agentSession.send).not.toHaveBeenCalled()
      expect(mockElectronAPI.agentSession.sendByTaskId).toHaveBeenCalledWith('task-1', 'Hello', undefined)
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
      ;(mockElectronAPI.agentSession.send as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        newSessionId: 'sess-2-new'
      })

      await act(async () => {
        await result.current.sendMessage('After resume')
      })

      // Should use the NEW sessionId from store, not the old one from closure
      expect(mockElectronAPI.agentSession.send).toHaveBeenCalledWith('sess-2-new', 'After resume', 'task-1', 'agent-1', undefined)
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
