import { useState, useEffect, useCallback, useRef } from 'react'
import { agentSessionApi, onAgentOutput, onAgentStatus, onAgentApproval } from '@/lib/ipc-client'
import type { AgentOutputEvent, AgentStatusEvent, AgentApprovalRequest } from '@/types/electron'

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  partType?: string
  tool?: {
    name: string
    status: string
    title?: string
    input?: string
    output?: string
    error?: string
    questions?: Array<{
      header: string
      question: string
      options: Array<{ label: string; description: string }>
    }>
    todos?: Array<{
      id: string
      content: string
      status: 'pending' | 'in_progress' | 'completed'
      priority?: string
    }>
  }
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
  start: (agentId: string, taskId: string, workspaceDir?: string) => Promise<string>
  abort: () => Promise<void>
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

  // Use a ref to track the sessionId so event handlers always see the latest value
  // (avoids stale closure from React state)
  const sessionIdRef = useRef<string | null>(null)
  const seenIdsRef = useRef<Set<string>>(new Set())

  // Subscribe to IPC events once on mount, filter by ref
  useEffect(() => {
    const cleanupOutput = onAgentOutput((event: AgentOutputEvent) => {
      if (!sessionIdRef.current || event.sessionId !== sessionIdRef.current) return

      const data = event.data as any

      let role: 'user' | 'assistant' | 'system' = 'system'
      let content = ''
      let msgId = ''

      if (typeof data === 'object' && data !== null) {
        role = data.role === 'user' ? 'user' : data.role === 'assistant' ? 'assistant' : 'system'
        content = data.content ?? data.text ?? data.message ?? JSON.stringify(data)
        msgId = data.id || ''
      } else {
        content = String(data)
      }

      if (!content) return

      // Generate stable ID for dedup
      if (!msgId) {
        msgId = `${role}-${content.slice(0, 50)}-${content.length}`
      }

      // Streaming update — replace content, tool, and partType of existing message
      if (data.update && seenIdsRef.current.has(msgId)) {
        setSession((prev) => ({
          ...prev,
          messages: prev.messages.map((m) =>
            m.id === msgId ? {
              ...m,
              content,
              ...(data.partType && { partType: data.partType }),
              ...(data.tool && { tool: data.tool })
            } : m
          )
        }))
        return
      }

      // Skip already-seen messages
      if (seenIdsRef.current.has(msgId)) return
      seenIdsRef.current.add(msgId)

      setSession((prev) => ({
        ...prev,
        messages: [
          ...prev.messages,
          {
            id: msgId,
            role,
            content,
            timestamp: new Date(),
            partType: data.partType,
            tool: data.tool
          }
        ]
      }))
    })

    const cleanupStatus = onAgentStatus((event: AgentStatusEvent) => {
      if (!sessionIdRef.current || event.sessionId !== sessionIdRef.current) return

      setSession((prev) => ({
        ...prev,
        status: event.status
      }))
    })

    const cleanupApproval = onAgentApproval((event: AgentApprovalRequest) => {
      if (!sessionIdRef.current || event.sessionId !== sessionIdRef.current) return

      setSession((prev) => ({
        ...prev,
        pendingApproval: event,
        status: 'waiting_approval'
      }))
    })

    return () => {
      cleanupOutput()
      cleanupStatus()
      cleanupApproval()
    }
  }, []) // Subscribe once — sessionIdRef handles filtering

  const start = useCallback(async (agentId: string, taskId: string, workspaceDir?: string) => {
    setIsLoading(true)
    setError(null)

    // Reset seen messages for new session
    seenIdsRef.current = new Set()

    try {
      const { sessionId } = await agentSessionApi.start(agentId, taskId, workspaceDir)

      // Update ref FIRST so event handlers can match immediately
      sessionIdRef.current = sessionId

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

  const abort = useCallback(async () => {
    const currentId = sessionIdRef.current
    if (!currentId) return

    try {
      await agentSessionApi.abort(currentId)
      setSession((prev) => ({ ...prev, status: 'idle' }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to abort session')
      throw err
    }
  }, [])

  const stop = useCallback(async () => {
    const currentId = sessionIdRef.current
    if (!currentId) return

    setIsLoading(true)
    try {
      await agentSessionApi.stop(currentId)
      sessionIdRef.current = null
      seenIdsRef.current = new Set()
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
  }, [])

  const sendMessage = useCallback(async (message: string) => {
    const currentId = sessionIdRef.current
    if (!currentId) throw new Error('No active session')

    try {
      await agentSessionApi.send(currentId, message)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message')
      throw err
    }
  }, [])

  const approve = useCallback(async (approved: boolean, message?: string) => {
    const currentId = sessionIdRef.current
    if (!currentId) throw new Error('No active session')

    try {
      await agentSessionApi.approve(currentId, approved, message)
      setSession((prev) => ({
        ...prev,
        pendingApproval: null,
        status: approved ? 'working' : 'idle'
      }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to respond to permission request')
      throw err
    }
  }, [])

  const clearError = useCallback(() => setError(null), [])

  return {
    session,
    isLoading,
    error,
    start,
    abort,
    stop,
    sendMessage,
    approve,
    clearError
  }
}
