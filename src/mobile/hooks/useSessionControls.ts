import { useCallback, useRef } from 'react'
import { useAgentStore } from '../stores/agent-store'
import { api } from '../api/client'

/**
 * Shared session control handlers used by both ConversationPage and TaskDetailPage.
 * Provides double-click protection via busyRef and rollback on failure via endSession.
 */
export function useSessionControls(taskId: string) {
  const initSession = useAgentStore((s) => s.initSession)
  const endSession = useAgentStore((s) => s.endSession)
  const clearMessageDedup = useAgentStore((s) => s.clearMessageDedup)
  const busyRef = useRef(false)

  const handleStart = useCallback(async (agentId: string) => {
    if (busyRef.current) return
    busyRef.current = true
    initSession(taskId, '', agentId)
    try {
      const { sessionId } = await api.sessions.start(agentId, taskId)
      initSession(taskId, sessionId, agentId)
    } catch (e) {
      console.error('Failed to start session:', e)
      endSession(taskId)
    } finally {
      busyRef.current = false
    }
  }, [taskId, initSession, endSession])

  const handleResume = useCallback(async (agentId: string, existingSessionId: string) => {
    if (busyRef.current) return
    busyRef.current = true
    clearMessageDedup(taskId)
    initSession(taskId, '', agentId)
    try {
      const { sessionId } = await api.sessions.resume(existingSessionId, agentId, taskId)
      initSession(taskId, sessionId, agentId)
    } catch (e) {
      console.error('Failed to resume session:', e)
      endSession(taskId)
    } finally {
      busyRef.current = false
    }
  }, [taskId, initSession, endSession, clearMessageDedup])

  const handleStop = useCallback(async (sessionId: string) => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      await api.sessions.stop(sessionId)
      endSession(taskId)
    } catch (e) {
      console.error('Failed to stop session:', e)
    } finally {
      busyRef.current = false
    }
  }, [taskId, endSession])

  const handleRestart = useCallback(async (agentId: string, currentSessionId: string) => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      await api.sessions.stop(currentSessionId)
      endSession(taskId)
      clearMessageDedup(taskId)
      initSession(taskId, '', agentId)
      const { sessionId } = await api.sessions.start(agentId, taskId)
      initSession(taskId, sessionId, agentId)
    } catch (e) {
      console.error('Failed to restart session:', e)
      endSession(taskId)
    } finally {
      busyRef.current = false
    }
  }, [taskId, initSession, endSession, clearMessageDedup])

  return { handleStart, handleResume, handleStop, handleRestart, busyRef }
}
