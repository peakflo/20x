import { UsageLimitRecoveryNotice } from '../components/UsageLimitRecoveryNotice'
import { memo, useRef, useEffect, useLayoutEffect, useCallback, useMemo, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useTaskStore } from '../stores/task-store'
import { useAgentStore, SessionStatus, type AgentMessage } from '../stores/agent-store'
import { api } from '../api/client'
import { useSessionControls } from '../hooks/useSessionControls'
import { MessageActivityGroup, MessageBubble, isCompactActivityMessage } from '../components/MessageBubble'
import { ArtifactCard } from '../components/ArtifactCard'
import { ChatInput, type ChatInputAttachment } from '../components/ChatInput'
import { useArtifactStore } from '../stores/artifact-store'
import type { Artifact } from '@shared/artifacts'
import { cn } from '../lib/utils'
import { captureAnalyticsEvent } from '@/lib/analytics'
import type { Route } from '../App'

function collectSearchableText(value: unknown, output: string[]): void {
  if (value == null) return
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    output.push(String(value))
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectSearchableText(item, output))
    return
  }
  if (typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => collectSearchableText(item, output))
  }
}

// Stable empty list — a fresh `[]` per render would invalidate every memo and
// effect keyed on `messages` while no session exists.
const EMPTY_MESSAGES: AgentMessage[] = []
const EMPTY_ARTIFACTS: Artifact[] = []

// Approximate rendered height (px) of the "Agent is working..." row (dots +
// label, with its vertical padding). Used to grow the virtualizer's end
// padding so the row still clears the floating composer overlap below it.
const WORKING_INDICATOR_HEIGHT = 36

// Cache per message object: search runs over the whole transcript on every
// keystroke AND every streamed delta. Message objects are identity-stable per
// part (store projection cache), so a WeakMap makes this compute-once.
const messageSearchTextCache = new WeakMap<AgentMessage, string>()

function getMessageSearchText(message: AgentMessage): string {
  const cached = messageSearchTextCache.get(message)
  if (cached !== undefined) return cached
  const parts: string[] = []
  collectSearchableText(message.role, parts)
  collectSearchableText(message.partType, parts)
  collectSearchableText(message.content, parts)
  collectSearchableText(message.tool, parts)
  collectSearchableText(message.taskProgress, parts)
  const text = parts.join('\n').toLowerCase()
  messageSearchTextCache.set(message, text)
  return text
}

type TranscriptItem =
  | { type: 'message'; key: string; message: AgentMessage }
  | { type: 'activity'; key: string; messages: AgentMessage[] }

function getTranscriptItemSearchText(item: TranscriptItem): string {
  if (item.type === 'activity') {
    return item.messages.map(getMessageSearchText).join('\n')
  }
  return getMessageSearchText(item.message)
}

function getMessageContentLength(message: AgentMessage): number {
  return typeof message.content === 'string' ? message.content.length : 0
}

function getTranscriptItemContentLength(item: TranscriptItem | undefined): number {
  if (!item) return 0
  if (item.type === 'activity') {
    return item.messages.reduce((total, message) => total + getMessageContentLength(message), 0)
  }
  return getMessageContentLength(item.message)
}

const TranscriptRow = memo(function TranscriptRow({
  item,
  activeQuestionId,
  normalizedSearchQuery,
  onAnswer,
  artifacts,
  onOpenArtifact
}: {
  item: TranscriptItem
  activeQuestionId: string | null
  normalizedSearchQuery: string
  onAnswer: (answer: string) => void
  artifacts: Artifact[]
  onOpenArtifact: (artifact: Artifact) => void
}) {
  if (item.type === 'activity') {
    return <MessageActivityGroup messages={item.messages} searchQuery={normalizedSearchQuery} artifacts={artifacts} onOpenArtifact={onOpenArtifact} />
  }

  return (
    <MessageBubble
      message={item.message}
      onAnswer={onAnswer}
      canAnswerQuestion={item.message.id === activeQuestionId}
      searchQuery={normalizedSearchQuery}
      artifacts={artifacts}
      onOpenArtifact={onOpenArtifact}
    />
  )
})

export function ConversationPage({ taskId, onNavigate }: { taskId: string; onNavigate: (route: Route) => void }) {
  const task = useTaskStore((s) => s.tasks.find((t) => t.id === taskId))
  const session = useAgentStore((s) => s.sessions.get(taskId))
  const initSession = useAgentStore((s) => s.initSession)
  const bindTranscript = useAgentStore((s) => s.bindTranscript)
  const beginSend = useAgentStore((s) => s.beginSend)
  const endSend = useAgentStore((s) => s.endSend)
  const artifactsByTask = useArtifactStore((s) => s.artifactsByTask)
  const hydrateArtifacts = useArtifactStore((s) => s.hydrate)
  const artifacts = artifactsByTask.get(taskId) || EMPTY_ARTIFACTS
  const openArtifact = useCallback((artifact: Artifact) => onNavigate({ page: 'artifact', taskId, artifactId: artifact.id }), [onNavigate, taskId])

  // Bind this task's transcript from the durable projection on open (and taskId
  // change). The view renders projection state; live updates arrive as deltas.
  useEffect(() => {
    void bindTranscript(taskId)
  }, [taskId, bindTranscript])

  useEffect(() => {
    void hydrateArtifacts(taskId)
  }, [hydrateArtifacts, taskId])

  const scrollRef = useRef<HTMLDivElement>(null)
  const topOverlayRef = useRef<HTMLDivElement>(null)
  const [topOverlayHeight, setTopOverlayHeight] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const isAtBottomRef = useRef(true)
  const scrollRafRef = useRef<number | null>(null)
  const autoScrollRafRef = useRef<number | null>(null)
  const [todosExpanded, setTodosExpanded] = useState(false)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [isMoreOpen, setIsMoreOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeSearchResult, setActiveSearchResult] = useState(0)
  const [showAttachmentPicker, setShowAttachmentPicker] = useState(false)
  const [messageAttachments, setMessageAttachments] = useState<ChatInputAttachment[]>([])

  // Stable empty list — a fresh `[]` per render would invalidate every memo and
  // effect keyed on `messages` while no session exists.
  const messages = session?.messages || EMPTY_MESSAGES
  const normalizedSearchQuery = searchQuery.trim().toLowerCase()

  const transcriptItems = useMemo<TranscriptItem[]>(() => {
    const items: TranscriptItem[] = []
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      if (!isCompactActivityMessage(message)) {
        items.push({ type: 'message', key: message.id, message })
        continue
      }

      const group: AgentMessage[] = [message]
      while (index + 1 < messages.length && isCompactActivityMessage(messages[index + 1])) {
        index += 1
        group.push(messages[index])
      }
      items.push({ type: 'activity', key: group[0].id, messages: group })
    }
    return items
  }, [messages])

  const searchResultIndexes = useMemo(() => {
    if (!normalizedSearchQuery) return []
    return transcriptItems.reduce<number[]>((matches, item, index) => {
      if (getTranscriptItemSearchText(item).includes(normalizedSearchQuery)) {
        matches.push(index)
      }
      return matches
    }, [])
  }, [normalizedSearchQuery, transcriptItems])
  const activeSearchItemIndex = searchResultIndexes[activeSearchResult] ?? -1
  const lastTranscriptItemContentLength = useMemo(
    () => getTranscriptItemContentLength(transcriptItems[transcriptItems.length - 1]),
    [transcriptItems]
  )

  // Determine if the agent is actively working
  const isWorking = session?.status === SessionStatus.WORKING
  const isWaitingApproval = session?.status === SessionStatus.WAITING_APPROVAL
  const hasSession = !!session?.sessionId
  // The user sent a message and the backend is still resuming the session.
  const isStarting = !!session?.pendingSend && !isWorking && !isWaitingApproval

  const activeQuestionId = useMemo(() => {
    let questionIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].partType === 'question' && messages[i].tool?.questions) {
        questionIndex = i
        break
      }
    }
    if (questionIndex === -1) return null

    const hasUserReplyAfter = messages.slice(questionIndex + 1).some((m) => m.role === 'user')
    if (hasUserReplyAfter) return null

    return messages[questionIndex].id
  }, [messages])

  // Smart routing: detect if last message is a question
  const isQuestion = !!activeQuestionId

  // Can the user send input? Blocked while the session is starting (resuming)
  // to prevent a confusing double-send during the init window.
  const canSendInput = hasSession && !isStarting && (isWorking || isWaitingApproval || session?.status === SessionStatus.IDLE)
  const taskAttachments = useMemo(
    () => (Array.isArray(task?.attachments) ? task.attachments : []) as ChatInputAttachment[],
    [task?.attachments]
  )

  // Extract latest todos from messages — matches desktop TodoSummary logic
  const latestTodos = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].tool?.todos && messages[i].tool!.todos!.length > 0) {
        return messages[i].tool!.todos!
      }
    }
    return null
  }, [messages])

  useLayoutEffect(() => {
    const element = topOverlayRef.current
    if (!element) { setTopOverlayHeight(0); return }
    const measure = () => setTopOverlayHeight(Math.ceil(element.getBoundingClientRect().height))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [isSearchOpen, latestTodos, normalizedSearchQuery, todosExpanded])

  // Input placeholder — matches desktop AgentTranscriptPanel
  const placeholder = useMemo(() => {
    if (!hasSession) return 'No active session'
    if (isStarting) return 'Starting agent…'
    if (isQuestion) return 'Type your answer...'
    if (isWaitingApproval) return 'Approve or provide feedback...'
    return 'Write a message...'
  }, [hasSession, isStarting, isQuestion, isWaitingApproval])

  // Smart send handler — mirrors desktop TaskWorkspace.handleSend logic
  const handleSend = useCallback(
    async (message: string, options?: { attachments?: ChatInputAttachment[] }) => {
      // Get latest session from store, not from closure, to avoid stale closure bug
      const currentSession = useAgentStore.getState().sessions.get(taskId)
      if (!currentSession?.sessionId) return
      try {
        if (isQuestion) {
          const activeQuestion = currentSession.messages.find((item) => item.id === activeQuestionId)
          const responseType = activeQuestion?.tool?.name === 'permission' ? 'permission' : 'question'
          await api.sessions.approve(currentSession.sessionId, true, message, responseType, activeQuestion?.tool?.requestId)
          captureAnalyticsEvent('agent_approval_responded', {
            task_id: taskId,
            agent_id: currentSession.agentId,
            session_id: currentSession.sessionId,
            approved: true,
            has_message: Boolean(message)
          })
        } else {
          // Resuming an idle session is slow. Show "starting" immediately (the
          // send request blocks until the resume completes) so the UI isn't
          // stuck on "Idle" with an open input. Cleared by the first non-idle
          // status (see the store) or here on failure.
          beginSend(taskId)
          const result = await api.sessions.send(
            currentSession.sessionId,
            message,
            taskId,
            currentSession.agentId,
            options?.attachments
          )
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
        }
        setMessageAttachments([])
        setShowAttachmentPicker(false)
      } catch (e) {
        console.error('Failed to send message:', e)
        endSend(taskId)
      }
    },
    [taskId, isQuestion, activeQuestionId, initSession, beginSend, endSend]
  )

  // Handle question answer from QuestionMessage options
  const handleAnswer = useCallback(
    async (answer: string) => {
      // Get latest session from store, not from closure, to avoid stale closure bug
      const currentSession = useAgentStore.getState().sessions.get(taskId)
      if (!currentSession?.sessionId || !activeQuestionId) return
      try {
        const activeQuestion = currentSession.messages.find((item) => item.id === activeQuestionId)
        const responseType = activeQuestion?.tool?.name === 'permission' ? 'permission' : 'question'
        await api.sessions.approve(currentSession.sessionId, true, answer, responseType, activeQuestion?.tool?.requestId)
        captureAnalyticsEvent('agent_approval_responded', {
          task_id: taskId,
          agent_id: currentSession.agentId,
          session_id: currentSession.sessionId,
          approved: true,
          has_message: Boolean(answer),
          source: 'question_option'
        })
      } catch (e) {
        console.error('Failed to send answer:', e)
      }
    },
    [taskId, activeQuestionId]
  )

  const toggleAttachment = useCallback((attachment: ChatInputAttachment) => {
    setMessageAttachments((prev) => {
      const exists = prev.some((att) => att.id === attachment.id)
      if (exists) return prev.filter((att) => att.id !== attachment.id)
      return [...prev, attachment]
    })
  }, [])

  const removeAttachment = useCallback((attachmentId: string) => {
    setMessageAttachments((prev) => prev.filter((att) => att.id !== attachmentId))
  }, [])

  useEffect(() => {
    // Prune selections when task attachments change
    const validIds = new Set(taskAttachments.map((att) => att.id))
    setMessageAttachments((prev) => prev.filter((att) => validIds.has(att.id)))
  }, [taskAttachments])

  useEffect(() => {
    setActiveSearchResult(0)
  }, [normalizedSearchQuery])

  useEffect(() => {
    if (activeSearchResult >= searchResultIndexes.length) {
      setActiveSearchResult(Math.max(searchResultIndexes.length - 1, 0))
    }
  }, [activeSearchResult, searchResultIndexes.length])

  // Session controls (shared hook provides double-click protection and rollback)
  const { handleStart: _startSession, handleResume: _resumeSession, handleStop: _stopSession, handleRestart: _restartSession } = useSessionControls(taskId)

  const handleStart = useCallback(() => {
    if (task?.agent_id) _startSession(task.agent_id)
  }, [task?.agent_id, _startSession])

  const handleResume = useCallback(() => {
    if (task?.agent_id && task?.session_id) _resumeSession(task.agent_id, task.session_id)
  }, [task?.agent_id, task?.session_id, _resumeSession])

  const handleStop = useCallback(() => {
    if (session?.sessionId) _stopSession(session.sessionId)
  }, [session?.sessionId, _stopSession])

  const handleRestart = useCallback(() => {
    if (task?.agent_id && session?.sessionId) _restartSession(task.agent_id, session.sessionId)
  }, [task?.agent_id, session?.sessionId, _restartSession])

  const headerClearance = topOverlayHeight > 0 ? topOverlayHeight + 12 : isSearchOpen ? (normalizedSearchQuery ? 192 : 144) : 80
  const hasLeadingContent = Boolean(session?.systemStatus || artifacts.length)
  const virtualizer = useVirtualizer({
    count: transcriptItems.length,
    getScrollElement: () => scrollRef.current,
    paddingStart: hasLeadingContent ? 0 : headerClearance,
    // Reserve extra room for the "Agent is working" row rendered as the last
    // transcript item below, so it still clears the floating composer instead
    // of landing inside its own clearance gap.
    paddingEnd: isWorking ? 80 + WORKING_INDICATOR_HEIGHT : 80,
    scrollPaddingEnd: isWorking ? 80 + WORKING_INDICATOR_HEIGHT : 80,
    estimateSize: () => 120,
    overscan: 8
  })

  useEffect(() => {
    if (activeSearchItemIndex < 0) return
    virtualizer.scrollToIndex(activeSearchItemIndex, { align: 'center' })
    isAtBottomRef.current = false
    setShowScrollToBottom(true)
  }, [activeSearchItemIndex, virtualizer])

  // Auto-scroll to bottom when new rows arrive or the last row streams content.
  useEffect(() => {
    if (activeSearchItemIndex >= 0) return
    if (transcriptItems.length > 0 && isAtBottomRef.current) {
      if (autoScrollRafRef.current !== null) {
        cancelAnimationFrame(autoScrollRafRef.current)
      }
      autoScrollRafRef.current = requestAnimationFrame(() => {
        autoScrollRafRef.current = null
        if (!isAtBottomRef.current) return
        virtualizer.scrollToIndex(transcriptItems.length - 1, { align: 'end' })
      })
    }
    return () => {
      if (autoScrollRafRef.current !== null) {
        cancelAnimationFrame(autoScrollRafRef.current)
        autoScrollRafRef.current = null
      }
    }
  }, [activeSearchItemIndex, lastTranscriptItemContentLength, transcriptItems.length, virtualizer])

  // Track scroll position
  const handleScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      if (!scrollRef.current) return
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 80
      isAtBottomRef.current = isAtBottom
      setShowScrollToBottom(!isAtBottom)
    })
  }, [])

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current)
      }
      if (autoScrollRafRef.current !== null) {
        cancelAnimationFrame(autoScrollRafRef.current)
      }
    }
  }, [])

  const scrollToBottom = useCallback(() => {
    if (transcriptItems.length > 0) {
      virtualizer.scrollToIndex(transcriptItems.length - 1, { align: 'end' })
      isAtBottomRef.current = true
      setShowScrollToBottom(false)
    }
  }, [transcriptItems.length, virtualizer])

  const goToSearchResult = useCallback((direction: 1 | -1) => {
    if (searchResultIndexes.length === 0) return
    setActiveSearchResult((current) => (current + direction + searchResultIndexes.length) % searchResultIndexes.length)
  }, [searchResultIndexes.length])

  const closeSearch = useCallback(() => {
    setSearchQuery('')
    setIsSearchOpen(false)
    setActiveSearchResult(0)
  }, [])

  // Session state flags — matches TaskDetailPage logic
  const isSessionRunning = session?.sessionId && (session.status === SessionStatus.WORKING || session.status === SessionStatus.WAITING_APPROVAL)
  const canStart = task?.agent_id && !task.session_id && (!session || session.status === SessionStatus.IDLE) && task.status !== 'completed'
  const canResume = task?.agent_id && task.session_id && !isSessionRunning && !session?.sessionId && (!session || session.status === SessionStatus.IDLE)
  const canStop = isSessionRunning

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header — matches desktop AgentTranscriptPanel header */}
      <div ref={topOverlayRef} className="glass-bar pointer-events-none relative z-10 shrink-0" style={topOverlayHeight > 0 ? { marginBottom: -topOverlayHeight } : undefined}>
      <div className="pointer-events-auto flex min-h-[68px] items-center justify-between gap-2 px-3 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <button onClick={() => onNavigate({ page: 'detail', taskId })} className="glass-action !h-[44px] !w-[44px] shrink-0" aria-label="Back to task">
            <svg className="w-4 h-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{task?.title || 'Agent transcript'}</div>
            {session && (
            <span className={cn(
              'text-[11px] flex items-center gap-1',
              isStarting && 'text-green-400',
              !isStarting && session.status === SessionStatus.WORKING && 'text-green-400',
              !isStarting && session.status === SessionStatus.ERROR && 'text-red-400',
              !isStarting && session.status === SessionStatus.WAITING_APPROVAL && 'text-yellow-400',
              !isStarting && session.status === SessionStatus.IDLE && 'text-muted-foreground'
            )}>
              {(isStarting || session.status === SessionStatus.WORKING) && (
                <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
              )}
              {isStarting ? 'Starting…' : (
                <>
                  {session.status === SessionStatus.WORKING && 'Working'}
                  {session.status === SessionStatus.IDLE && 'Idle'}
                  {session.status === SessionStatus.ERROR && '● Error'}
                  {session.status === SessionStatus.WAITING_APPROVAL && '● Waiting'}
                </>
              )}
            </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* Icon buttons — matches desktop AgentTranscriptPanel */}
          <div className="relative flex items-center gap-1">
            <button
              onClick={() => {
                setIsSearchOpen((open) => {
                  const nextOpen = !open
                  if (nextOpen) requestAnimationFrame(() => searchInputRef.current?.focus())
                  return nextOpen
                })
              }}
              title="Search transcript"
              aria-label="Search transcript"
              className="glass-action !h-[44px] !w-[44px] text-muted-foreground hover:text-foreground"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
              </svg>
            </button>
            {((messages.length > 0 && hasSession) || canStop || canStart || canResume) && <>
              <button type="button" onClick={() => setIsMoreOpen((open) => !open)} className="glass-action !h-[44px] !w-[44px] text-muted-foreground hover:text-foreground" aria-label="Conversation actions" aria-expanded={isMoreOpen} aria-controls="conversation-actions">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
              </button>
              {isMoreOpen && (
                <div id="conversation-actions" role="menu" className="glass-popover absolute right-0 top-12 z-30 min-w-40 rounded-2xl border p-1 text-foreground">
                  {messages.length > 0 && hasSession && <button role="menuitem" className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-accent" onClick={() => { setIsMoreOpen(false); handleRestart() }}>Restart session</button>}
                  {canStop && <button role="menuitem" className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-accent" onClick={() => { setIsMoreOpen(false); handleStop() }}>Stop session</button>}
                  {canStart && <button role="menuitem" className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-accent" onClick={() => { setIsMoreOpen(false); handleStart() }}>Start agent</button>}
                  {canResume && <button role="menuitem" className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-accent" onClick={() => { setIsMoreOpen(false); handleResume() }}>Resume session</button>}
                </div>
              )}
            </>}
          </div>
        </div>
      </div>

      <div className="pointer-events-auto"><UsageLimitRecoveryNotice taskId={taskId} /></div>

      {isSearchOpen && (
        <div className="pointer-events-auto shrink-0 flex min-h-16 flex-wrap items-center gap-2 px-3 py-2">
          <div className={cn('relative min-w-0 flex-1', normalizedSearchQuery && '!w-full !flex-none')}>
            <svg className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
            </svg>
            <input
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') closeSearch()
                if (e.key === 'Enter') {
                  e.preventDefault()
                  goToSearchResult(e.shiftKey ? -1 : 1)
                }
              }}
              placeholder="Search transcript..."
              className="glass-control h-[48px] w-full pl-9 pr-14 text-sm text-foreground placeholder:text-[var(--glass-placeholder)] focus:outline-none focus:ring-1 focus:ring-ring/30"
            />
            {normalizedSearchQuery && <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[11px] tabular-nums text-muted-foreground">
              {`${searchResultIndexes.length ? activeSearchResult + 1 : 0}/${searchResultIndexes.length}`}
            </span>}
          </div>
          {normalizedSearchQuery && <>
          <button
            onClick={() => goToSearchResult(-1)}
            disabled={searchResultIndexes.length === 0}
            title="Previous result"
            aria-label="Previous search result"
            className="glass-action !h-[40px] !w-[40px] text-muted-foreground hover:text-foreground"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m18 15-6-6-6 6"/>
            </svg>
          </button>
          <button
            onClick={() => goToSearchResult(1)}
            disabled={searchResultIndexes.length === 0}
            title="Next result"
            aria-label="Next search result"
            className="glass-action !h-[40px] !w-[40px] text-muted-foreground hover:text-foreground"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6"/>
            </svg>
          </button>
          </>}
          <button
            onClick={closeSearch}
            title="Close search"
            aria-label="Close transcript search"
            className="glass-action !h-[40px] !w-[40px] text-muted-foreground hover:text-foreground"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
            </svg>
          </button>
        </div>
      )}
      {/* Pinned todo summary — matches desktop TodoSummary subheader */}
      {latestTodos && (
        <div className="glass-todo-summary pointer-events-auto mx-3 mb-2 shrink-0 overflow-hidden rounded-xl">
          <button
            onClick={() => setTodosExpanded(!todosExpanded)}
            className="w-full flex items-center gap-2 px-4 py-2 text-xs hover:bg-accent/30 transition-colors"
          >
            {/* Chevron */}
            <svg className={cn('h-3 w-3 text-muted-foreground shrink-0 transition-transform', todosExpanded && 'rotate-90')} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m9 18 6-6-6-6"/>
            </svg>
            {/* ListTodo icon */}
            <svg className="h-3.5 w-3.5 text-muted-foreground shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>
            </svg>
            <span className="text-muted-foreground font-medium">Tasks</span>
            <span className="text-muted-foreground ml-auto tabular-nums">
              {latestTodos.filter((t) => t.status === 'completed').length}/{latestTodos.length}
              {latestTodos.filter((t) => t.status === 'in_progress').length > 0 && (
                <span className="text-yellow-400 ml-1.5">
                  ({latestTodos.filter((t) => t.status === 'in_progress').length} active)
                </span>
              )}
            </span>
          </button>
          {todosExpanded && (
            <div className="px-4 pb-2.5 space-y-0.5">
              {latestTodos.map((todo) => (
                <div
                  key={todo.id}
                  className={cn(
                    'flex items-start gap-2 rounded px-2 py-1 text-xs',
                    todo.status === 'completed' && 'opacity-50'
                  )}
                >
                  {/* Status icon */}
                  {todo.status === 'completed' && (
                    <svg className="h-3.5 w-3.5 text-green-400 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="m9 12 2 2 4-4"/>
                    </svg>
                  )}
                  {todo.status === 'in_progress' && (
                    <svg className="h-3.5 w-3.5 text-yellow-400 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                    </svg>
                  )}
                  {todo.status === 'pending' && (
                    <svg className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/>
                    </svg>
                  )}
                  <span className={todo.status === 'completed' ? 'line-through text-muted-foreground' : 'text-foreground'}>
                    {todo.content}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      </div>

      {/* Messages area — matches desktop transcript panel */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto px-4 space-y-2 text-sm"
        >
          {hasLeadingContent && <div aria-hidden="true" style={{ height: headerClearance }} />}
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

          {/* System status bar (e.g. 'Compacting conversation history…') */}
          {session?.systemStatus && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-yellow-500/10 rounded-md border border-yellow-500/20">
              <svg className="h-3 w-3 text-yellow-400 animate-spin shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
              </svg>
              <span className="text-xs text-yellow-300">{session.systemStatus}</span>
            </div>
          )}

          {artifacts.length > 0 && (
            <div className="space-y-2 pb-2" aria-label="Task artifacts">
              {artifacts.slice(0, 3).map((artifact) => (
                <ArtifactCard
                  key={`${artifact.id}:${artifact.reloadTrigger}`}
                  artifact={artifact}
                  onOpen={() => onNavigate({ page: 'artifact', taskId, artifactId: artifact.id })}
                />
              ))}
            </div>
          )}

          {messages.length > 0 && (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const item = transcriptItems[virtualRow.index]
                return (
                  <div
                    key={item.key}
                    ref={virtualizer.measureElement}
                    data-index={virtualRow.index}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      transform: `translateY(${virtualRow.start}px)`
                    }}
                  >
                    <div className="pb-2 rounded-md">
                      <TranscriptRow
                        item={item}
                        activeQuestionId={activeQuestionId}
                        normalizedSearchQuery={normalizedSearchQuery}
                        onAnswer={handleAnswer}
                        artifacts={artifacts}
                        onOpenArtifact={openArtifact}
                      />
                    </div>
                  </div>
                )
              })}
              {/* Working indicator — positioned as the last row inside this
                  sized/relative wrapper (right after the last message, at
                  totalSize - paddingEnd) rather than as a sibling rendered
                  after it, which would fall inside the virtualizer's
                  end-padding gap and end up hidden underneath the floating
                  composer below. */}
              {isWorking && (
                <div
                  className="flex items-center gap-2 px-3 py-2"
                  style={{
                    position: 'absolute',
                    top: virtualizer.getTotalSize() - 80 - WORKING_INDICATOR_HEIGHT,
                    left: 0,
                    right: 0
                  }}
                >
                  <div className="flex gap-1">
                    <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
                    <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse [animation-delay:0.2s]" />
                    <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse [animation-delay:0.4s]" />
                  </div>
                  <span className="text-xs text-muted-foreground">Agent is working...</span>
                </div>
              )}
            </div>
          )}
        </div>
        {/* Scroll to bottom button */}
        {showScrollToBottom && messages.length > 0 && (
          <button
            onClick={scrollToBottom}
            className="glass-action absolute bottom-32 right-4 z-20 !h-[44px] !w-[44px] text-muted-foreground hover:text-foreground"
            title="Scroll to bottom"
            aria-label="Scroll to bottom"
          >
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>
            </svg>
          </button>
        )}
      </div>

      {/* Input area — matches desktop transcript panel input */}
      <div className="glass-bar glass-composer-rail pointer-events-none relative z-10 shrink-0 -mt-[80px]">
        {showAttachmentPicker && taskAttachments.length > 0 && (
          <div className="glass-popover pointer-events-auto mx-3 mb-2 max-h-40 overflow-y-auto rounded-2xl border px-3 py-2">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground">Attach files to this message</span>
              <button
                type="button"
                onClick={() => setShowAttachmentPicker(false)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Done
              </button>
            </div>
            <div className="space-y-1">
              {taskAttachments.map((attachment) => {
                const checked = messageAttachments.some((att) => att.id === attachment.id)
                return (
                  <button
                    key={attachment.id}
                    type="button"
                    onClick={() => toggleAttachment(attachment)}
                    className={cn(
                      'w-full text-left rounded-md px-2 py-1.5 border text-xs transition-colors',
                      checked
                        ? 'border-primary/40 bg-primary/10 text-foreground'
                        : 'border-border/50 text-muted-foreground hover:text-foreground hover:bg-white/5'
                    )}
                  >
                    {attachment.filename}
                  </button>
                )
              })}
            </div>
          </div>
        )}
        <ChatInput
          onSend={handleSend}
          disabled={!canSendInput}
          placeholder={placeholder}
          attachments={messageAttachments}
          onRemoveAttachment={removeAttachment}
          onOpenAttachmentPicker={taskAttachments.length > 0 ? () => setShowAttachmentPicker((prev) => !prev) : undefined}
        />
      </div>
    </div>
  )
}
