import { useRef, useEffect, useCallback, useMemo } from 'react'
import { useTaskStore } from '../stores/task-store'
import { useAgentStore } from '../stores/agent-store'
import { api } from '../api/client'
import { MessageBubble } from '../components/MessageBubble'
import { ChatInput } from '../components/ChatInput'
import { cn } from '../lib/utils'
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

  // Input placeholder — matches desktop AgentTranscriptPanel
  const placeholder = useMemo(() => {
    if (!hasSession) return 'No active session'
    if (isQuestion) return 'Type your answer...'
    if (isWaitingApproval) return 'Approve or provide feedback...'
    return 'Send a message... (Shift+Enter for new line)'
  }, [hasSession, isQuestion, isWaitingApproval])

  // Smart send handler — mirrors desktop TaskWorkspace.handleSend logic
  const handleSend = useCallback(
    async (message: string) => {
      if (!session?.sessionId) return
      try {
        if (isQuestion) {
          await api.sessions.approve(session.sessionId, true, message)
        } else {
          const result = await api.sessions.send(session.sessionId, message, taskId, session.agentId)
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

  // Session state flags — matches TaskDetailPage logic
  const isSessionRunning = session?.sessionId && (session.status === 'working' || session.status === 'waiting_approval')
  const canStart = task?.agent_id && !task.session_id && (!session || session.status === 'idle') && task.status !== 'completed'
  const canResume = task?.agent_id && task.session_id && !isSessionRunning && !session?.sessionId && (!session || session.status === 'idle')
  const canStop = isSessionRunning

  return (
    <div className="flex flex-col h-full bg-[#0d1117]">
      {/* Header — matches desktop AgentTranscriptPanel header */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-border/50">
        <button onClick={() => onNavigate({ page: 'detail', taskId })} className="p-1.5 active:opacity-60 hover:bg-accent rounded-md transition-colors">
          <svg className="w-4 h-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <svg className="h-4 w-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>
        </svg>
        <h1 className="text-sm font-medium truncate flex-1">{task?.title || 'Agent Transcript'}</h1>

        {/* Status indicator — matches desktop */}
        {session && (
          <span className={cn(
            'text-xs flex items-center gap-1',
            session.status === 'working' && 'text-green-400',
            session.status === 'error' && 'text-red-400',
            session.status === 'waiting_approval' && 'text-yellow-400',
            session.status === 'idle' && 'text-muted-foreground'
          )}>
            {session.status === 'working' && (
              <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            )}
            {session.status === 'working' && 'Working'}
            {session.status === 'idle' && 'Idle'}
            {session.status === 'error' && '● Error'}
            {session.status === 'waiting_approval' && '● Waiting'}
          </span>
        )}

        {/* Session action button in header */}
        {canStop && (
          <button onClick={handleStop} className="text-xs text-red-400 px-3 py-1 border border-red-400/30 rounded-md active:opacity-60 hover:bg-red-500/10 transition-colors">
            Stop
          </button>
        )}
        {canStart && (
          <button onClick={handleStart} className="text-xs bg-primary text-primary-foreground px-3 py-1 rounded-md active:opacity-80 hover:bg-primary/90">
            Start
          </button>
        )}
        {canResume && (
          <button onClick={handleResume} className="text-xs bg-primary text-primary-foreground px-3 py-1 rounded-md active:opacity-80 hover:bg-primary/90">
            Resume
          </button>
        )}
      </div>

      {/* Messages area — matches desktop transcript panel */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4 space-y-2 font-mono text-sm"
      >
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
            {!hasSession && !canStart && !canResume && (
              <>
                <svg className="h-8 w-8 opacity-20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>
                </svg>
                <p className="text-xs">No agent session available</p>
              </>
            )}
            {(canStart || canResume) && (
              <>
                <svg className="h-8 w-8 opacity-20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>
                </svg>
                <p className="text-xs">No messages yet</p>
                <button
                  onClick={canResume ? handleResume : handleStart}
                  className="bg-primary text-primary-foreground text-xs font-medium px-4 py-2 rounded-md active:opacity-80 mt-2 hover:bg-primary/90"
                >
                  {canResume ? 'Resume Session' : 'Start Agent'}
                </button>
              </>
            )}
            {hasSession && messages.length === 0 && (
              <>
                <svg className="h-8 w-8 opacity-30 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                </svg>
                <p className="text-xs">Starting agent session...</p>
              </>
            )}
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

      {/* Message count footer — matches desktop */}
      {messages.length > 0 && (
        <div className="px-4 py-2 text-[10px] text-muted-foreground font-mono border-t border-border/30">
          {messages.length} messages
        </div>
      )}

      {/* Input area — matches desktop transcript panel input */}
      <div className="shrink-0 border-t border-border/50">
        <ChatInput
          onSend={handleSend}
          disabled={!canSendInput}
          placeholder={placeholder}
        />
      </div>
    </div>
  )
}
