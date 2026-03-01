import { useMemo, useCallback } from 'react'
import { TaskStatus } from '@shared/constants'
import { Markdown } from '@/components/ui/Markdown'
import { useTaskStore } from '../stores/task-store'
import { useAgentStore } from '../stores/agent-store'
import { api } from '../api/client'
import { Badge } from '../components/Badge'
import { PriorityBadge } from '../components/PriorityBadge'
import { TaskStatusDot } from '../components/TaskStatusDot'
import { MessageBubble } from '../components/MessageBubble'
import { cn, formatDate, isOverdue, formatRelativeDate, STATUS_VARIANT } from '../lib/utils'
import type { Route } from '../App'

export function TaskDetailPage({ taskId, onNavigate }: { taskId: string; onNavigate: (route: Route) => void }) {
  const task = useTaskStore((s) => s.tasks.find((t) => t.id === taskId))
  const agents = useAgentStore((s) => s.agents)
  const session = useAgentStore((s) => s.sessions.get(taskId))
  const initSession = useAgentStore((s) => s.initSession)
  const endSession = useAgentStore((s) => s.endSession)
  const clearMessageDedup = useAgentStore((s) => s.clearMessageDedup)

  const agent = useMemo(() => agents.find((a) => a.id === task?.agent_id), [agents, task?.agent_id])

  // Session is already synced and running (from desktop or elsewhere)
  const isSessionRunning = session?.sessionId && (session.status === 'working' || session.status === 'waiting_approval')

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

  if (!task) {
    return (
      <div className="flex flex-col h-full">
        <Header onBack={() => onNavigate({ page: 'list' })} title="Not found" />
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Task not found</div>
      </div>
    )
  }

  // Session state logic — don't show Resume if session is already running
  const canStart = task.agent_id && !task.session_id && (!session || session.status === 'idle') && task.status !== TaskStatus.Completed
  const canResume = task.agent_id && task.session_id && !isSessionRunning && (!session?.sessionId) && (!session || session.status === 'idle')
  const canStop = isSessionRunning
  const hasMessages = session && session.messages.length > 0

  // Preview: last 3 messages
  const previewMessages = session?.messages.slice(-3) || []

  return (
    <div className="flex flex-col h-full">
      <Header onBack={() => onNavigate({ page: 'list' })} title={task.title} />

      <div className="flex-1 overflow-y-auto">
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
            <Markdown size="sm">{task.description}</Markdown>
          </div>
        )}

        {/* Metadata grid — matches desktop grid-cols-[auto_1fr] */}
        <div className="px-4 py-4 border-b border-border">
          <div className="grid grid-cols-[auto_1fr] gap-x-10 gap-y-3 text-sm">
            {agent && (
              <>
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>
                  Agent
                </span>
                <span className="text-foreground">{agent.name}</span>
              </>
            )}
            {task.repos.length > 0 && (
              <>
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>
                  Repos
                </span>
                <span className="text-foreground">{task.repos.join(', ')}</span>
              </>
            )}
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
            {task.labels.length > 0 && (
              <>
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/></svg>
                  Labels
                </span>
                <div className="flex flex-wrap gap-1">
                  {task.labels.map((l) => (
                    <Badge key={l} variant="blue">{l}</Badge>
                  ))}
                </div>
              </>
            )}
            <>
              <span className="text-muted-foreground flex items-center gap-1.5">
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                Updated
              </span>
              <span className="text-foreground">{formatRelativeDate(task.updated_at)}</span>
            </>
          </div>
        </div>

        {/* Agent controls */}
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          {canStart && (
            <button onClick={handleStart} className="inline-flex items-center justify-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm h-8 rounded-md px-3 text-xs font-medium">
              Start Agent
            </button>
          )}
          {canResume && (
            <button onClick={handleResume} className="inline-flex items-center justify-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm h-8 rounded-md px-3 text-xs font-medium">
              Resume Session
            </button>
          )}
          {canStop && (
            <button onClick={handleStop} className="inline-flex items-center justify-center gap-2 bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-sm h-8 rounded-md px-3 text-xs font-medium">
              Stop
            </button>
          )}
          {session && (
            <span className={cn(
              'text-xs ml-auto flex items-center gap-1.5',
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
        </div>

        {/* Transcript preview — matches desktop transcript panel style */}
        {hasMessages && (
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
                <span className="text-xs text-primary">View all →</span>
              </div>
            </button>
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
          </div>
        )}
      </div>
    </div>
  )
}

function Header({ onBack, title }: { onBack: () => void; title: string }) {
  return (
    <div className="shrink-0 flex items-center gap-2 px-2 py-3 border-b border-border">
      <button onClick={onBack} className="p-2 active:opacity-60 hover:bg-accent rounded-md transition-colors">
        <svg className="w-5 h-5 text-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m15 18-6-6 6-6" />
        </svg>
      </button>
      <h1 className="text-sm font-semibold truncate flex-1">{title}</h1>
    </div>
  )
}
