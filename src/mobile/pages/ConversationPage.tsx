import { useRef, useEffect, useCallback, useMemo } from 'react'
import { useTaskStore } from '../stores/task-store'
import { useAgentStore, type AgentMessage } from '../stores/agent-store'
import { api } from '../api/client'
import { MessageBubble } from '../components/MessageBubble'
import { ChatInput } from '../components/ChatInput'
import type { Route } from '../App'

export function ConversationPage({ taskId, onNavigate }: { taskId: string; onNavigate: (route: Route) => void }) {
  const task = useTaskStore((s) => s.tasks.find((t) => t.id === taskId))
  const session = useAgentStore((s) => s.sessions.get(taskId))
  const initSession = useAgentStore((s) => s.initSession)
  const endSession = useAgentStore((s) => s.endSession)
  const clearMessageDedup = useAgentStore((s) => s.clearMessageDedup)

  const scrollRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)

  const messages = session?.messages || []
  const lastMessage = messages[messages.length - 1]

  // Determine if the agent is actively working
  const isWorking = session?.status === 'working'
  const isWaitingApproval = session?.status === 'waiting_approval'
  const hasSession = !!session?.sessionId

  // Smart routing: detect if last message is a question
  const isQuestion = lastMessage?.partType === 'question' && !!lastMessage?.tool?.questions

  // Can the user send input?
  const canSendInput = hasSession && (isWorking || isWaitingApproval || session?.status === 'idle')

  // Input placeholder
  const placeholder = useMemo(() => {
    if (!hasSession) return 'No active session'
    if (isQuestion) return 'Type your answer...'
    if (isWaitingApproval) return 'Approve or provide feedback...'
    if (isWorking) return 'Send a message to the agent...'
    return 'Send a message...'
  }, [hasSession, isQuestion, isWaitingApproval, isWorking])

  // Smart send handler — mirrors desktop TaskWorkspace.handleSend logic
  const handleSend = useCallback(
    async (message: string) => {
      if (!session?.sessionId) return
      try {
        if (isQuestion) {
          // Answer to a question — use approve
          await api.sessions.approve(session.sessionId, true, message)
        } else {
          // Regular message
          const result = await api.sessions.send(session.sessionId, message, taskId, session.agentId)
          // Session was recreated — update store
          if (result.newSessionId && taskId) {
            initSession(taskId, result.newSessionId, session.agentId)
          }
        }
      } catch (e) {
        console.error('Failed to send message:', e)
      }
    },
    [session, taskId, isQuestion, initSession]
  )

  // Handle question answer from QuestionMessage options
  const handleAnswer = useCallback(
    async (answer: string) => {
      if (!session?.sessionId) return
      try {
        await api.sessions.approve(session.sessionId, true, answer)
      } catch (e) {
        console.error('Failed to send answer:', e)
      }
    },
    [session]
  )

  // Session controls
  const handleStart = useCallback(async () => {
    if (!task?.agent_id) return
    initSession(task.id, '', task.agent_id)
    try {
      const { sessionId } = await api.sessions.start(task.agent_id, task.id)
      initSession(task.id, sessionId, task.agent_id)
    } catch (e) {
      console.error('Failed to start session:', e)
    }
  }, [task, initSession])

  const handleResume = useCallback(async () => {
    if (!task?.agent_id || !task.session_id) return
    clearMessageDedup(task.id)
    initSession(task.id, '', task.agent_id)
    try {
      const { sessionId } = await api.sessions.resume(task.session_id, task.agent_id, task.id)
      initSession(task.id, sessionId, task.agent_id)
    } catch (e) {
      console.error('Failed to resume session:', e)
    }
  }, [task, initSession, clearMessageDedup])

  const handleStop = useCallback(async () => {
    if (!session?.sessionId) return
    try {
      await api.sessions.stop(session.sessionId)
      endSession(taskId)
    } catch (e) {
      console.error('Failed to stop session:', e)
    }
  }, [session, taskId, endSession])

  const handleAbort = useCallback(async () => {
    if (!session?.sessionId) return
    try {
      await api.sessions.abort(session.sessionId)
    } catch (e) {
      console.error('Failed to abort:', e)
    }
  }, [session])

  // Auto-scroll to bottom when new messages arrive (only if user is at bottom)
  useEffect(() => {
    if (isAtBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages.length, lastMessage?.content])

  // Track scroll position
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 80
  }, [])

  // Session state flags
  const canStart = task?.agent_id && !task.session_id && (!session || session.status === 'idle') && task.status !== 'completed'
  const canResume = task?.agent_id && task.session_id && !session?.sessionId && (!session || session.status === 'idle')
  const canStop = session?.sessionId && (session.status === 'working' || session.status === 'waiting_approval')

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-2 px-2 py-3 border-b border-border/30">
        <button onClick={() => onNavigate({ page: 'detail', taskId })} className="p-2 active:opacity-60">
          <svg className="w-5 h-5 text-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold truncate">{task?.title || 'Conversation'}</h1>
          {session && (
            <span className={`text-[10px] ${
              session.status === 'working' ? 'text-green-400' :
              session.status === 'error' ? 'text-red-400' :
              session.status === 'waiting_approval' ? 'text-yellow-400' :
              'text-muted-foreground'
            }`}>
              {session.status === 'working' && '\u25CF Working'}
              {session.status === 'idle' && '\u25CB Idle'}
              {session.status === 'error' && '\u25CF Error'}
              {session.status === 'waiting_approval' && '\u25CF Waiting for approval'}
            </span>
          )}
        </div>
        {/* Session action button in header */}
        {canStop && (
          <button onClick={handleStop} className="text-xs text-red-400 px-3 py-1.5 border border-red-400/30 rounded-lg active:opacity-60">
            Stop
          </button>
        )}
        {canStart && (
          <button onClick={handleStart} className="text-xs text-primary px-3 py-1.5 border border-primary/30 rounded-lg active:opacity-60">
            Start
          </button>
        )}
        {canResume && (
          <button onClick={handleResume} className="text-xs text-primary px-3 py-1.5 border border-primary/30 rounded-lg active:opacity-60">
            Resume
          </button>
        )}
      </div>

      {/* Messages area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-3"
      >
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm gap-2">
            {!hasSession && !canStart && !canResume && (
              <p>No agent session available</p>
            )}
            {(canStart || canResume) && (
              <>
                <p>No messages yet</p>
                <button
                  onClick={canResume ? handleResume : handleStart}
                  className="bg-primary text-primary-foreground text-xs font-medium px-5 py-2.5 rounded-lg active:opacity-80 mt-2"
                >
                  {canResume ? 'Resume Session' : 'Start Agent'}
                </button>
              </>
            )}
            {hasSession && <p>Waiting for agent response...</p>}
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} onAnswer={handleAnswer} />
        ))}

        {/* Working indicator */}
        {isWorking && messages.length > 0 && (
          <div className="flex items-center gap-2 px-3 py-2">
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
              <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse [animation-delay:0.2s]" />
              <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse [animation-delay:0.4s]" />
            </div>
            <span className="text-xs text-muted-foreground">Agent is working...</span>
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t border-border/30 bg-background">
        {/* Abort button when agent is working */}
        {isWorking && hasSession && (
          <div className="px-4 pt-2">
            <button
              onClick={handleAbort}
              className="w-full text-xs text-yellow-400 py-2 border border-yellow-400/30 rounded-lg active:opacity-60"
            >
              Interrupt Agent
            </button>
          </div>
        )}
        <ChatInput
          onSend={handleSend}
          disabled={!canSendInput}
          placeholder={placeholder}
        />
      </div>
    </div>
  )
}
