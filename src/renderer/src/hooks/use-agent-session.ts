import { useState, useEffect, useCallback, useRef } from 'react'
import { agentSessionApi, onAgentOutput, onAgentStatus, onAgentApproval } from '@/lib/ipc-client'
import type { AgentOutputEvent, AgentStatusEvent, AgentApprovalRequest } from '@/types/electron'

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
}

export interface AgentSessionState {
  sessionId: string | null
  status: 'idle' | 'working' | 'error' | 'waiting_approval'
  messages: AgentMessage[]
  pendingApproval: AgentApprovalRequest | null
}

interface UseAgentSessionResult {
  session: AgentSessionState
  isLoading: boolean
  error: string | null
  start: (agentId: string, taskId: string) => Promise<string>
  stop: () => Promise<void>
  sendMessage: (message: string) => Promise<void>
  approve: (approved: boolean, message?: string) => Promise<void>
  clearError: () => void
}

export function useAgentSession(): UseAgentSessionResult {
  const [session, setSession] = useState<AgentSessionState>({
    sessionId: null,
    status: 'idle',
    messages: [],
    pendingApproval: null
  })
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Use refs to track cleanup functions
  const cleanupOutputRef = useRef<(() => void) | null>(null)
  const cleanupStatusRef = useRef<(() => void) | null>(null)
  const cleanupApprovalRef = useRef<(() => void) | null>(null)

  // Setup event listeners
  useEffect(() => {
    cleanupOutputRef.current = onAgentOutput((event: AgentOutputEvent) => {
      if (event.sessionId !== session.sessionId) return

      setSession(prev => {
        // Extract role and content from the event data
        let role: 'user' | 'assistant' | 'system' = 'system'
        let content = ''
        
        if (typeof event.data === 'object' && event.data !== null) {
          const data = event.data as any
          if (data.role === 'user') {
            role = 'user'
          } else if (data.role === 'assistant') {
            role = 'assistant'
          }
          
          if (data.content !== undefined) {
            content = String(data.content)
          } else if (data.text !== undefined) {
            content = String(data.text)
          } else {
            content = JSON.stringify(data)
          }
        } else {
          content = String(event.data)
        }

        // Avoid duplicate messages by checking if this exact content already exists
        const isDuplicate = prev.messages.some(
          m => m.content === content && m.role === role
        )
        
        if (isDuplicate) {
          return prev
        }

        return {
          ...prev,
          messages: [
            ...prev.messages,
            {
              id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              role,
              content,
              timestamp: new Date()
            }
          ]
        }
      })
    })

    cleanupStatusRef.current = onAgentStatus((event: AgentStatusEvent) => {
      if (event.sessionId !== session.sessionId) return

      setSession(prev => ({
        ...prev,
        status: event.status
      }))
    })

    cleanupApprovalRef.current = onAgentApproval((event: AgentApprovalRequest) => {
      if (event.sessionId !== session.sessionId) return

      setSession(prev => ({
        ...prev,
        pendingApproval: event,
        status: 'waiting_approval'
      }))
    })

    return () => {
      cleanupOutputRef.current?.()
      cleanupStatusRef.current?.()
      cleanupApprovalRef.current?.()
    }
  }, [session.sessionId])

  const start = useCallback(async (agentId: string, taskIdParam: string) => {
    setIsLoading(true)
    setError(null)

    try {
      const { sessionId } = await agentSessionApi.start(agentId, taskIdParam)
      setSession({
        sessionId,
        status: 'working',
        messages: [],
        pendingApproval: null
      })
      return sessionId
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start session')
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [])

  const stop = useCallback(async () => {
    if (!session.sessionId) return

    setIsLoading(true)
    try {
      await agentSessionApi.stop(session.sessionId)
      setSession({
        sessionId: null,
        status: 'idle',
        messages: [],
        pendingApproval: null
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop session')
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [session.sessionId])

  const sendMessage = useCallback(async (message: string) => {
    if (!session.sessionId) {
      throw new Error('No active session')
    }

    // Add user message to transcript
    setSession(prev => ({
      ...prev,
      messages: [
        ...prev.messages,
        {
          id: `msg-${Date.now()}`,
          role: 'user',
          content: message,
          timestamp: new Date()
        }
      ]
    }))

    try {
      await agentSessionApi.send(session.sessionId, message)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message')
      throw err
    }
  }, [session.sessionId])

  const approve = useCallback(async (approved: boolean, message?: string) => {
    if (!session.sessionId) {
      throw new Error('No active session')
    }

    try {
      await agentSessionApi.approve(session.sessionId, approved, message)
      setSession(prev => ({
        ...prev,
        pendingApproval: null,
        status: approved ? 'working' : 'idle'
      }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to respond to permission request')
      throw err
    }
  }, [session.sessionId])

  const clearError = useCallback(() => {
    setError(null)
  }, [])

  return {
    session,
    isLoading,
    error,
    start,
    stop,
    sendMessage,
    approve,
    clearError
  }
}
