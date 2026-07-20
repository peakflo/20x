import { useCallback } from 'react'
import { agentSessionApi } from '@/lib/ipc-client'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { captureAnalyticsEvent } from '@/lib/analytics'
import type { AgentApprovalRequest } from '@/types/electron'

export type { AgentMessage } from '@/stores/agent-store'

export interface AgentSessionState {
  sessionId: string | null
  status: SessionStatus
  messages: import('@/stores/agent-store').AgentMessage[]
  pendingApproval: AgentApprovalRequest | null
  /** Transient system status indicator (e.g. 'compacting') — cleared on next non-status message */
  systemStatus?: string | null
}

export interface SendMessageOptions {
  attachments?: Array<{
    id: string
    filename: string
    size: number
    mime_type: string
  }>
}

const EMPTY_SESSION: AgentSessionState = {
  sessionId: null,
  status: SessionStatus.IDLE,
  messages: [],
  pendingApproval: null
}

export function useAgentSession(taskId: string | undefined) {
  const session = useAgentStore((s) => (taskId ? s.sessions.get(taskId) : undefined))
  const initSession = useAgentStore((s) => s.initSession)
  const endSession = useAgentStore((s) => s.endSession)
  const clearMessageDedup = useAgentStore((s) => s.clearMessageDedup)

  const sessionState: AgentSessionState = session
    ? {
        sessionId: session.sessionId,
        status: session.status,
        messages: session.messages,
        pendingApproval: session.pendingApproval,
        systemStatus: session.systemStatus
      }
    : EMPTY_SESSION

  const start = useCallback(
    async (agentId: string, tId: string, workspaceDir?: string, skipInitialPrompt?: boolean) => {
      // Pre-register so events arriving during start() are captured via taskId fallback
      initSession(tId, '', agentId)
      const { sessionId } = await agentSessionApi.start(agentId, tId, workspaceDir, skipInitialPrompt)
      // Update with the real sessionId (preserves any messages that arrived early)
      initSession(tId, sessionId, agentId)
      captureAnalyticsEvent('agent_session_started', {
        task_id: tId,
        agent_id: agentId,
        session_id: sessionId,
        has_workspace_dir: Boolean(workspaceDir),
        skip_initial_prompt: Boolean(skipInitialPrompt)
      })
      return sessionId
    },
    [initSession]
  )

  const removeSession = useAgentStore((s) => s.removeSession)

  const resume = useCallback(
    async (agentId: string, tId: string, ocSessionId: string) => {
      // Clear message dedup so replayed messages will be added
      clearMessageDedup(tId)
      initSession(tId, '', agentId)
      const result = await agentSessionApi.resume(agentId, tId, ocSessionId)
      if (result.ended) {
        // Session ended normally (task completed) — clean up the pre-registered session
        removeSession(tId)
        captureAnalyticsEvent('agent_session_resume_ended', {
          task_id: tId,
          agent_id: agentId,
          previous_session_id: ocSessionId
        })
        return ''
      }
      initSession(tId, result.sessionId, agentId)
      captureAnalyticsEvent('agent_session_resumed', {
        task_id: tId,
        agent_id: agentId,
        session_id: result.sessionId,
        previous_session_id: ocSessionId
      })
      return result.sessionId
    },
    [initSession, clearMessageDedup, removeSession]
  )

  const abort = useCallback(async () => {
    const currentSession = useAgentStore.getState().sessions.get(taskId!)
    if (!currentSession?.sessionId) return
    await agentSessionApi.abort(currentSession.sessionId)
    captureAnalyticsEvent('agent_session_aborted', {
      task_id: taskId,
      agent_id: currentSession.agentId,
      session_id: currentSession.sessionId
    })
  }, [taskId])

  const stop = useCallback(async () => {
    if (!taskId) return
    const currentSession = useAgentStore.getState().sessions.get(taskId)
    if (currentSession?.sessionId) {
      console.log('[use-agent-session] stop() called for session:', currentSession.sessionId)
      await agentSessionApi.stop(currentSession.sessionId)
      captureAnalyticsEvent('agent_session_stopped', {
        task_id: taskId,
        agent_id: currentSession.agentId,
        session_id: currentSession.sessionId,
        fallback: false
      })
    } else {
      // Fallback: session mapping lost in renderer — ask the backend
      // to find and stop the session by taskId directly.
      console.log('[use-agent-session] stop() no sessionId, falling back to stopByTaskId:', taskId)
      await agentSessionApi.stopByTaskId(taskId)
      captureAnalyticsEvent('agent_session_stopped', {
        task_id: taskId,
        fallback: true
      })
    }
    endSession(taskId)
  }, [taskId, endSession])

  const sendMessage = useCallback(
    async (message: string, options?: SendMessageOptions) => {
      if (!taskId) throw new Error('No taskId')
      // Get latest session from store, not from closure
      const currentSession = useAgentStore.getState().sessions.get(taskId)
      if (currentSession?.sessionId) {
        const result = await agentSessionApi.send(currentSession.sessionId, message, taskId, currentSession.agentId, options?.attachments)
        // Session was recreated on the main process — update renderer store
        if (result.newSessionId && taskId) {
          initSession(taskId, result.newSessionId, currentSession.agentId)
        }
        captureAnalyticsEvent('agent_message_sent', {
          task_id: taskId,
          agent_id: currentSession.agentId,
          session_id: result.newSessionId || currentSession.sessionId,
          attachment_count: options?.attachments?.length ?? 0,
          recovered_session: Boolean(result.newSessionId)
        })
      } else {
        // Fallback: session mapping lost in renderer — ask the backend
        // to find (or resume/create) the session by taskId directly.
        console.log('[use-agent-session] sendMessage() no sessionId, falling back to sendByTaskId:', taskId)
        const result = await agentSessionApi.sendByTaskId(taskId, message, options?.attachments)
        // Update renderer store with the recovered/new sessionId
        const resolvedSessionId = result.newSessionId || result.sessionId
        if (resolvedSessionId) {
          initSession(taskId, resolvedSessionId, currentSession?.agentId ?? '')
        }
        captureAnalyticsEvent('agent_message_sent', {
          task_id: taskId,
          session_id: resolvedSessionId,
          attachment_count: options?.attachments?.length ?? 0,
          fallback: true
        })
      }
    },
    [taskId, initSession]
  )

  const approve = useCallback(
    async (approved: boolean, message?: string) => {
      const currentSession = useAgentStore.getState().sessions.get(taskId!)
      if (!currentSession?.sessionId) throw new Error('No active session')
      await agentSessionApi.approve(currentSession.sessionId, approved, message)
      captureAnalyticsEvent('agent_approval_responded', {
        task_id: taskId,
        agent_id: currentSession.agentId,
        session_id: currentSession.sessionId,
        approved,
        has_message: Boolean(message)
      })
    },
    [taskId]
  )

  return { session: sessionState, start, resume, abort, stop, sendMessage, approve }
}
