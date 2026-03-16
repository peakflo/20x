import { useMemo, useCallback, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { TaskStatus } from '@shared/constants'
import { CollapsibleDescription } from '../components/CollapsibleDescription'
import { useTaskStore, type Task } from '../stores/task-store'
import { useAgentStore, SessionStatus } from '../stores/agent-store'
import { api } from '../api/client'
import { useSessionControls } from '../hooks/useSessionControls'
import { Badge } from '../components/Badge'
import { PriorityBadge } from '../components/PriorityBadge'
import { TaskStatusDot } from '../components/TaskStatusDot'
import { MessageBubble } from '../components/MessageBubble'
import { cn, formatDate, isOverdue, formatRelativeDate, formatRelativeFuture, STATUS_VARIANT, STATUS_DOT_COLORS } from '../lib/utils'
import type { Route } from '../App'

export function TaskDetailPage({ taskId, onNavigate }: { taskId: string; onNavigate: (route: Route) => void }) {
  const task = useTaskStore((s) => s.tasks.find((t) => t.id === taskId))
  const updateTask = useTaskStore((s) => s.updateTask)
  const agents = useAgentStore((s) => s.agents)
  const skills = useAgentStore((s) => s.skills)
  const session = useAgentStore((s) => s.sessions.get(taskId))
  const initSession = useAgentStore((s) => s.initSession)
  const endSession = useAgentStore((s) => s.endSession)

  const [showFeedback, setShowFeedback] = useState(false)
  const { handleStart: _startSession, handleResume: _resumeSession, handleStop: _stopSession, busyRef } = useSessionControls(taskId)

  // Session is already synced and running (from desktop or elsewhere)
  const isSessionRunning = session?.sessionId && (session.status === SessionStatus.WORKING || session.status === SessionStatus.WAITING_APPROVAL)

  const handleAssignAgent = useCallback(async (agentId: string | null) => {
    if (!task) return
    await updateTask(task.id, { agent_id: agentId || null })
  }, [task, updateTask])

  const handleTriage = useCallback(async () => {
    if (!task || task.agent_id || busyRef.current) return
    const defaultAgent = agents.find((a) => a.is_default) || agents[0]
    if (!defaultAgent) return
    busyRef.current = true
    try {
      await updateTask(task.id, { status: TaskStatus.Triaging })
      initSession(task.id, '', defaultAgent.id)
      const { sessionId } = await api.sessions.start(defaultAgent.id, task.id)
      initSession(task.id, sessionId, defaultAgent.id)
    } catch (e) {
      console.error('Failed to triage:', e)
      endSession(task.id)
      await updateTask(task.id, { status: TaskStatus.NotStarted })
    } finally {
      busyRef.current = false
    }
  }, [task, agents, updateTask, initSession, endSession])

  const handleUpdateSkillIds = useCallback(async (ids: string[] | null) => {
    if (!task) return
    await updateTask(task.id, { skill_ids: ids })
  }, [task, updateTask])

  const handleRemoveRepo = useCallback(async (repo: string) => {
    if (!task) return
    await updateTask(task.id, { repos: task.repos.filter((r) => r !== repo) })
  }, [task, updateTask])

  // Session controls (shared hook provides double-click protection and rollback)
  const handleStart = useCallback(() => {
    if (task?.agent_id) _startSession(task.agent_id)
  }, [task?.agent_id, _startSession])

  const handleResume = useCallback(() => {
    if (task?.agent_id && task?.session_id) _resumeSession(task.agent_id, task.session_id)
  }, [task?.agent_id, task?.session_id, _resumeSession])

  const handleStop = useCallback(() => {
    if (session?.sessionId) _stopSession(session.sessionId)
  }, [session?.sessionId, _stopSession])

  const handleCompleteTask = useCallback(async () => {
    if (!task) return
    // Always show feedback when an agent is assigned (there may be a session to learn from)
    if (task.agent_id) {
      setShowFeedback(true)
    } else {
      // No agent — complete directly
      await updateTask(task.id, { status: TaskStatus.Completed })
    }
  }, [task, updateTask])

  const handleFeedbackSubmit = useCallback(async (rating: number, comment: string) => {
    if (!task || !task.agent_id) return
    setShowFeedback(false)

    // 1. Set task to AgentLearning status with feedback (matches desktop flow)
    await updateTask(task.id, {
      status: TaskStatus.AgentLearning,
      feedback_rating: rating,
      feedback_comment: comment || null
    })

    // 2. Build the same feedback prompt as desktop
    const commentPart = comment ? ` Comment: "${comment}".` : ''
    const today = new Date().toISOString().split('T')[0]
    const prompt = `User rated this session ${rating}/5.${commentPart}\n\nReview the session and update skills in .agents/skills/:\n\n**For skills you used:**\nUpdate the YAML frontmatter:\n- confidence: ${rating >= 4 ? '+0.05 (was helpful)' : rating <= 2 ? '-0.10 (was wrong/outdated)' : 'no change'}\n- uses: increment by 1\n- lastUsed: ${today}\n- tags: add relevant keywords if missing\n\n**If you discovered a new reusable pattern:**\nCreate a new skill file.\n\nUpdate existing skills that were helpful or create new ones for patterns worth reusing.`

    // 3. Resume the session (or start fresh if none) and send feedback prompt
    try {
      let activeSessionId = session?.sessionId
      if (!activeSessionId && task.session_id) {
        // Resume existing session from task record
        const { sessionId } = await api.sessions.resume(task.session_id, task.agent_id, task.id)
        activeSessionId = sessionId
        initSession(task.id, sessionId, task.agent_id)
      }
      if (activeSessionId) {
        await api.sessions.send(activeSessionId, prompt, task.id, task.agent_id)
        // Backend agent-manager will sync skills and auto-transition to Completed
        // when the session becomes idle (via transitionToIdle AgentLearning check)
      } else {
        // No session at all — just mark as completed with feedback
        await updateTask(task.id, { status: TaskStatus.Completed })
      }
    } catch (e) {
      console.error('Failed to send feedback to agent:', e)
      // Fallback: complete the task even if learning session fails
      await updateTask(task.id, { status: TaskStatus.Completed })
    }
  }, [task, session, updateTask, initSession])

  const handleFeedbackSkip = useCallback(async () => {
    if (!task) return
    setShowFeedback(false)
    await updateTask(task.id, { status: TaskStatus.Completed })
  }, [task, updateTask])

  // Skills available for this agent — must be before conditional return (Rules of Hooks)
  const agentSkills = useMemo(() => {
    if (!task?.agent_id) return []
    return skills.filter((s) => !s.agent_id || s.agent_id === task.agent_id)
  }, [skills, task?.agent_id])

  // Subtasks and parent task — use useShallow to prevent .filter() from returning
  // a new array reference on every selector call (which causes infinite re-renders
  // via useSyncExternalStore torn-read detection). Also use stable taskId (string)
  // instead of closing over the task object which changes reference on store updates.
  const subtasks = useTaskStore(useShallow((s) =>
    s.tasks.filter((t) => t.parent_task_id === taskId)
  ))

  const parentTask = useTaskStore((s) => {
    const currentTask = s.tasks.find((t) => t.id === taskId)
    if (!currentTask?.parent_task_id) return null
    return s.tasks.find((t) => t.id === currentTask.parent_task_id) || null
  })

  if (!task) {
    return (
      <div className="flex flex-col h-full">
        <Header onBack={() => onNavigate({ page: 'list' })} title="Not found" />
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Task not found</div>
      </div>
    )
  }

  // Session state logic — don't show Resume if session is already running
  const canStart = task.agent_id && !task.session_id && (!session || session.status === SessionStatus.IDLE) && task.status !== TaskStatus.Completed
  const canResume = task.agent_id && task.session_id && !isSessionRunning && (!session?.sessionId) && (!session || session.status === SessionStatus.IDLE)
  const canStop = isSessionRunning
  const canTriage = !task.agent_id && agents.length > 0 && task.status !== TaskStatus.Completed && task.status !== TaskStatus.Triaging && !isSessionRunning
  const canComplete = task.status !== TaskStatus.Completed && !isSessionRunning
  const hasMessages = session && session.messages.length > 0

  // Preview: last 3 messages
  const previewMessages = session?.messages.slice(-3) || []

  return (
    <div className="flex flex-col h-full">
      <Header
        onBack={() => parentTask ? onNavigate({ page: 'detail', taskId: parentTask.id }) : onNavigate({ page: 'list' })}
        title={task.title}
        rightAction={
          <button
            onClick={() => onNavigate({ page: 'edit', taskId })}
            className="p-2 active:opacity-60 hover:bg-accent rounded-md transition-colors"
            aria-label="Edit task"
          >
            <svg className="w-4 h-4 text-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>
            </svg>
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto">
        {/* Parent task breadcrumb */}
        {parentTask && (
          <button
            onClick={() => onNavigate({ page: 'detail', taskId: parentTask.id })}
            className="flex items-center gap-1.5 px-4 py-2 text-xs text-muted-foreground active:opacity-60 border-b border-border/30"
          >
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
            {parentTask.title}
          </button>
        )}

        {/* Badges bar — matches desktop TaskDetailView header */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border flex-wrap">
          <TaskStatusDot status={task.status} />
          {STATUS_VARIANT[task.status] && (
            <Badge variant={STATUS_VARIANT[task.status].variant}>{STATUS_VARIANT[task.status].label}</Badge>
          )}
          <PriorityBadge priority={task.priority} />
          {task.type !== 'general' && (
            <Badge variant={task.type === 'coding' ? 'blue' : task.type === 'review' ? 'purple' : 'default'}>
              {task.type}
            </Badge>
          )}
        </div>

        {/* Description — matches desktop max-w-2xl content area */}
        {task.description && (
          <div className="px-4 py-4 border-b border-border">
            <CollapsibleDescription
              taskId={task.id}
              description={task.description}
              size="sm"
            />
          </div>
        )}

        {/* Metadata grid — matches desktop grid-cols-[auto_1fr], always visible */}
        <div className="px-4 py-4 border-b border-border">
          <div className="grid grid-cols-[auto_1fr] gap-x-10 gap-y-3 text-sm">
            {/* Agent — always visible with select dropdown */}
            <span className="text-muted-foreground flex items-center gap-1.5">
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>
              Agent
            </span>
            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={task.agent_id || ''}
                onChange={(e) => handleAssignAgent(e.target.value || null)}
                className="bg-transparent border border-border rounded px-2 py-1 text-sm cursor-pointer text-foreground min-w-0"
              >
                <option value="">No agent assigned</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              {canTriage && (
                <button onClick={handleTriage} className="inline-flex items-center gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90 h-7 rounded-md px-3 text-xs font-medium shrink-0">
                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
                  </svg>
                  Triage
                </button>
              )}
              {canStart && (
                <button onClick={handleStart} className="inline-flex items-center gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90 h-7 rounded-md px-3 text-xs font-medium shrink-0">
                  Start
                </button>
              )}
              {canResume && (
                <button onClick={handleResume} className="inline-flex items-center gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90 h-7 rounded-md px-3 text-xs font-medium shrink-0">
                  Resume
                </button>
              )}
              {canStop && (
                <button onClick={handleStop} className="inline-flex items-center gap-1.5 bg-destructive text-destructive-foreground hover:bg-destructive/90 h-7 rounded-md px-3 text-xs font-medium shrink-0">
                  Stop
                </button>
              )}
              {canComplete && (
                <button onClick={handleCompleteTask} className="inline-flex items-center gap-1.5 bg-green-600 text-white hover:bg-green-700 h-7 rounded-md px-3 text-xs font-medium shrink-0">
                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                  Complete
                </button>
              )}
              {session && (
                <span className={cn(
                  'text-xs flex items-center gap-1.5 ml-auto',
                  session.status === SessionStatus.WORKING && 'text-green-400',
                  session.status === SessionStatus.ERROR && 'text-red-400',
                  session.status === SessionStatus.WAITING_APPROVAL && 'text-yellow-400',
                  session.status === SessionStatus.IDLE && 'text-muted-foreground'
                )}>
                  {session.status === SessionStatus.WORKING && (
                    <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                  )}
                  {session.status === SessionStatus.WORKING && 'Working'}
                  {session.status === SessionStatus.IDLE && 'Idle'}
                  {session.status === SessionStatus.ERROR && '● Error'}
                  {session.status === SessionStatus.WAITING_APPROVAL && '● Waiting'}
                </span>
              )}
            </div>

            {/* Repos — always visible, with add/remove */}
            <span className="text-muted-foreground flex items-center gap-1.5">
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>
              Repos
            </span>
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                {task.repos.map((repo) => (
                  <span key={repo} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] font-medium pr-1">
                    {repo.split('/').pop()}
                    <button
                      onClick={() => handleRemoveRepo(repo)}
                      className="rounded-full hover:bg-foreground/10 p-0.5"
                    >
                      <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
                      </svg>
                    </button>
                  </span>
                ))}
                <button
                  onClick={() => onNavigate({ page: 'repos', taskId })}
                  className="inline-flex items-center gap-1 h-6 px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
                >
                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14"/><path d="M12 5v14"/>
                  </svg>
                  Add
                </button>
              </div>
            </div>

            {/* Skills — visible when agent is assigned */}
            {task.agent_id && (
              <>
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
                  Skills
                </span>
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {task.skill_ids === null ? (
                      <span className="text-xs text-muted-foreground">Using agent defaults</span>
                    ) : (
                      <>
                        {task.skill_ids.map((skillId) => {
                          const skill = agentSkills.find((s) => s.id === skillId)
                          if (!skill) return null
                          return (
                            <span key={skillId} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] font-medium pr-1">
                              {skill.name}
                              <button
                                onClick={() => handleUpdateSkillIds(task.skill_ids!.filter((id) => id !== skillId))}
                                className="rounded-full hover:bg-foreground/10 p-0.5"
                              >
                                <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
                                </svg>
                              </button>
                            </span>
                          )
                        })}
                      </>
                    )}
                    <button
                      onClick={() => onNavigate({ page: 'skills', taskId })}
                      className="inline-flex items-center gap-1 h-6 px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
                    >
                      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 12h14"/><path d="M12 5v14"/>
                      </svg>
                      {task.skill_ids === null ? 'Customize' : 'Add'}
                    </button>
                    {task.skill_ids !== null && (
                      <button
                        onClick={() => handleUpdateSkillIds(null)}
                        className="text-xs text-muted-foreground active:opacity-60"
                      >
                        Reset to defaults
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}

            {/* Due date */}
            {task.due_date && (
              <>
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4" /><path d="M8 2v4" /><path d="M3 10h18" /></svg>
                  Due
                </span>
                <span className={isOverdue(task.due_date) ? 'text-red-400' : 'text-foreground'}>
                  {formatDate(task.due_date)}
                </span>
              </>
            )}

            {/* Labels — always visible */}
            <span className="text-muted-foreground flex items-center gap-1.5">
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/></svg>
              Labels
            </span>
            <div className="flex flex-wrap gap-1">
              {task.labels.length > 0 ? (
                task.labels.map((l) => (
                  <Badge key={l} variant="blue">{l}</Badge>
                ))
              ) : (
                <span className="text-muted-foreground text-xs">None</span>
              )}
            </div>

            {/* Updated */}
            <span className="text-muted-foreground flex items-center gap-1.5">
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              Updated
            </span>
            <span className="text-foreground">{formatRelativeDate(task.updated_at)}</span>

            {/* Heartbeat */}
            {(task.status === TaskStatus.ReadyForReview || task.heartbeat_enabled) && (
              <>
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <svg className={`h-3.5 w-3.5 ${task.heartbeat_enabled ? 'text-rose-500' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
                    <path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27" />
                  </svg>
                  Heartbeat
                </span>
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant={task.heartbeat_enabled ? 'green' : 'default'}>
                      {task.heartbeat_enabled ? 'On' : 'Off'}
                    </Badge>
                    {task.heartbeat_enabled && task.heartbeat_next_check_at && (
                      <span className="text-[10px] text-muted-foreground/60">
                        next {formatRelativeFuture(task.heartbeat_next_check_at)}
                      </span>
                    )}
                    <button
                      onClick={async () => {
                        await updateTask(task.id, { heartbeat_enabled: !task.heartbeat_enabled })
                      }}
                      className="text-xs text-primary active:opacity-60 ml-auto"
                    >
                      {task.heartbeat_enabled ? 'Disable' : 'Enable'}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Subtasks — shown for parent tasks (not subtasks themselves) */}
        {!task.parent_task_id && subtasks.length > 0 && (
          <SubtasksSection
            subtasks={subtasks}
            onNavigateToTask={(id) => onNavigate({ page: 'detail', taskId: id })}
          />
        )}

        {/* Transcript — always show link when agent is assigned */}
        {task.agent_id && (
          <div className="px-4 py-3">
            <button
              onClick={() => onNavigate({ page: 'conversation', taskId })}
              className="w-full text-left"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>
                  Agent Transcript
                </span>
                <span className="text-xs text-primary">Open →</span>
              </div>
            </button>
            {hasMessages && (
              <>
                <div className="space-y-2 bg-[#0d1117] rounded-md border border-border/50 p-3">
                  {previewMessages.map((msg) => (
                    <MessageBubble key={msg.id} message={msg} />
                  ))}
                </div>
                {session!.messages.length > 3 && (
                  <button
                    onClick={() => onNavigate({ page: 'conversation', taskId })}
                    className="w-full text-center text-xs text-primary mt-2 py-2 active:opacity-60 font-mono"
                  >
                    View all {session!.messages.length} messages
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Feedback modal */}
      {showFeedback && (
        <FeedbackModal
          onSubmit={handleFeedbackSubmit}
          onSkip={handleFeedbackSkip}
        />
      )}
    </div>
  )
}

function SubtasksSection({ subtasks, onNavigateToTask }: { subtasks: Task[]; onNavigateToTask: (taskId: string) => void }) {
  const completedCount = subtasks.filter(s => s.status === TaskStatus.Completed).length

  return (
    <div className="px-4 py-3 border-b border-border">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>
          </svg>
          Subtasks
          <span className="text-[10px] tabular-nums">({completedCount}/{subtasks.length})</span>
        </span>
      </div>
      <div className="rounded-md border border-border divide-y divide-border">
        {subtasks.map((subtask) => (
          <button
            key={subtask.id}
            onClick={() => onNavigateToTask(subtask.id)}
            className="w-full flex items-center gap-3 px-3 py-2.5 text-left active:bg-accent/50 transition-colors"
          >
            <div className={cn('h-1.5 w-1.5 rounded-full shrink-0', STATUS_DOT_COLORS[subtask.status] || 'bg-muted-foreground')} />
            <div className="min-w-0 flex-1">
              <div className="text-sm truncate">{subtask.title}</div>
            </div>
            <svg className="h-3.5 w-3.5 text-muted-foreground shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        ))}
      </div>
    </div>
  )
}

function FeedbackModal({ onSubmit, onSkip }: { onSubmit: (rating: number, comment: string) => void; onSkip: () => void }) {
  const [rating, setRating] = useState(0)
  const [comment, setComment] = useState('')

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/60" onClick={onSkip} />

      {/* Modal */}
      <div className="relative z-50 w-full max-w-md mx-4 mb-4 bg-card border border-border rounded-xl shadow-xl animate-in slide-in-from-bottom-4 duration-200">
        <div className="px-5 pt-5 pb-2">
          <h2 className="text-base font-semibold text-foreground">Session Feedback</h2>
          <p className="text-xs text-muted-foreground mt-1">Rate this session to help the agent improve</p>
        </div>

        {/* Star rating */}
        <div className="flex gap-2 justify-center py-4">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              type="button"
              onClick={() => setRating(star)}
              className="p-1 active:scale-110 transition-transform"
            >
              <svg
                className={`h-8 w-8 transition-colors ${
                  star <= rating
                    ? 'fill-amber-400 text-amber-400'
                    : 'text-muted-foreground/30 fill-none'
                }`}
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
            </button>
          ))}
        </div>

        {/* Comment */}
        <div className="px-5">
          <textarea
            placeholder="Optional feedback..."
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring/30 resize-none"
          />
        </div>

        {/* Actions */}
        <div className="flex gap-2 justify-end px-5 py-4">
          <button
            onClick={onSkip}
            className="h-9 px-4 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
          >
            Skip
          </button>
          <button
            onClick={() => { if (rating > 0) onSubmit(rating, comment) }}
            disabled={rating === 0}
            className="h-9 px-4 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Submit
          </button>
        </div>
      </div>
    </div>
  )
}

function Header({ onBack, title, rightAction }: { onBack: () => void; title: string; rightAction?: React.ReactNode }) {
  return (
    <div className="shrink-0 flex items-center gap-2 px-2 py-3 border-b border-border">
      <button onClick={onBack} className="p-2 active:opacity-60 hover:bg-accent rounded-md transition-colors">
        <svg className="w-5 h-5 text-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m15 18-6-6 6-6" />
        </svg>
      </button>
      <h1 className="text-sm font-semibold truncate flex-1">{title}</h1>
      {rightAction}
    </div>
  )
}
