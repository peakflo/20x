import { useCallback } from 'react'
import { agentSessionApi } from '@/lib/ipc-client'
import { useAgentStore } from '@/stores/agent-store'
import type { AgentApprovalRequest } from '@/types/electron'

export type { AgentMessage } from '@/stores/agent-store'

export interface AgentSessionState {
  sessionId: string | null
  status: 'idle' | 'working' | 'error' | 'waiting_approval'
  messages: import('@/stores/agent-store').AgentMessage[]
  pendingApproval: AgentApprovalRequest | null
}

const EMPTY_SESSION: AgentSessionState = {
  sessionId: null,
  status: 'idle',
  messages: [],
  pendingApproval: null
}

export function useAgentSession(taskId: string | undefined) {
  const session = useAgentStore((s) => (taskId ? s.sessions.get(taskId) : undefined))
  const initSession = useAgentStore((s) => s.initSession)
  const endSession = useAgentStore((s) => s.endSession)

  const sessionState: AgentSessionState = session
    ? {
        sessionId: session.sessionId,
        status: session.status,
        messages: session.messages,
        pendingApproval: session.pendingApproval
      }
    : EMPTY_SESSION

  const start = useCallback(
    async (agentId: string, tId: string, workspaceDir?: string) => {
      // Pre-register so events arriving during start() are captured via taskId fallback
      initSession(tId, '', agentId)
      const { sessionId } = await agentSessionApi.start(agentId, tId, workspaceDir)
      // Update with the real sessionId (preserves any messages that arrived early)
      initSession(tId, sessionId, agentId)
      return sessionId
    },
    [initSession]
  )

  const resume = useCallback(
    async (agentId: string, tId: string, ocSessionId: string) => {
      initSession(tId, '', agentId)
      const { sessionId } = await agentSessionApi.resume(agentId, tId, ocSessionId)
      initSession(tId, sessionId, agentId)
      return sessionId
    },
    [initSession]
  )

  const abort = useCallback(async () => {
    if (!session?.sessionId) return
    await agentSessionApi.abort(session.sessionId)
  }, [session?.sessionId])

  const stop = useCallback(async () => {
    if (!session?.sessionId || !taskId) return
    await agentSessionApi.stop(session.sessionId)
    endSession(taskId)
  }, [session?.sessionId, taskId, endSession])

  const sendMessage = useCallback(
    async (message: string) => {
      if (!session?.sessionId) throw new Error('No active session')
      const result = await agentSessionApi.send(session.sessionId, message, taskId)
      // Session was recreated on the main process — update renderer store
      if (result.newSessionId && taskId) {
        initSession(taskId, result.newSessionId, session.agentId)
      }
    },
    [session?.sessionId, session?.agentId, taskId, initSession]
  )

  const approve = useCallback(
    async (approved: boolean, message?: string) => {
      if (!session?.sessionId) throw new Error('No active session')
      await agentSessionApi.approve(session.sessionId, approved, message)
    },
    [session?.sessionId]
  )

  return { session: sessionState, start, resume, abort, stop, sendMessage, approve }
}
