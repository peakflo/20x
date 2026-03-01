import { useMemo, useCallback } from 'react'
import { TaskStatus } from '@shared/constants'
import { useTaskStore } from '../stores/task-store'
import { useAgentStore, type AgentMessage } from '../stores/agent-store'
import { api } from '../api/client'
import { TaskStatusDot } from '../components/TaskStatusDot'
import { PriorityBadge } from '../components/PriorityBadge'
import { MessageBubble } from '../components/MessageBubble'
import { STATUS_LABELS, formatRelativeDate, isOverdue, formatDate } from '../lib/utils'
import type { Route } from '../App'

export function TaskDetailPage({ taskId, onNavigate }: { taskId: string; onNavigate: (route: Route) => void }) {
  const task = useTaskStore((s) => s.tasks.find((t) => t.id === taskId))
  const agents = useAgentStore((s) => s.agents)
  const session = useAgentStore((s) => s.sessions.get(taskId))
  const initSession = useAgentStore((s) => s.initSession)
  const endSession = useAgentStore((s) => s.endSession)
  const clearMessageDedup = useAgentStore((s) => s.clearMessageDedup)

  const agent = useMemo(() => agents.find((a) => a.id === task?.agent_id), [agents, task?.agent_id])

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

  const canStart = task.agent_id && !task.session_id && (!session || session.status === 'idle') && task.status !== TaskStatus.Completed
  const canResume = task.agent_id && task.session_id && (!session?.sessionId) && (!session || session.status === 'idle')
  const canStop = session?.sessionId && (session.status === 'working' || session.status === 'waiting_approval')
  const hasMessages = session && session.messages.length > 0

  // Preview: last 3 messages
  const previewMessages = session?.messages.slice(-3) || []

  return (
    <div className="flex flex-col h-full">
      <Header onBack={() => onNavigate({ page: 'list' })} title={task.title} />

      <div className="flex-1 overflow-y-auto">
        {/* Status bar */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/30">
          <TaskStatusDot status={task.status} />
          <span className="text-xs text-muted-foreground">{STATUS_LABELS[task.status] || task.status}</span>
          <span className="text-xs text-muted-foreground">\u00B7</span>
          <PriorityBadge priority={task.priority} />
          {task.type !== 'general' && (
            <>
              <span className="text-xs text-muted-foreground">\u00B7</span>
              <span className="text-xs text-muted-foreground">{task.type}</span>
            </>
          )}
        </div>

        {/* Description */}
        {task.description && (
          <div className="px-4 py-3 border-b border-border/30">
            <div className="text-sm text-foreground/90 whitespace-pre-wrap">{task.description}</div>
          </div>
        )}

        {/* Metadata grid */}
        <div className="px-4 py-3 space-y-2 border-b border-border/30 text-xs">
          {agent && (
            <MetaRow label="Agent" value={agent.name} />
          )}
          {task.repos.length > 0 && (
            <MetaRow label="Repos" value={task.repos.join(', ')} />
          )}
          {task.due_date && (
            <MetaRow
              label="Due"
              value={formatDate(task.due_date)}
              valueClass={isOverdue(task.due_date) ? 'text-red-400' : undefined}
            />
          )}
          {task.labels.length > 0 && (
            <div className="flex items-start gap-3">
              <span className="text-muted-foreground w-16 shrink-0">Labels</span>
              <div className="flex flex-wrap gap-1">
                {task.labels.map((l) => (
                  <span key={l} className="bg-primary/20 text-primary px-1.5 py-0.5 rounded text-[10px]">{l}</span>
                ))}
              </div>
            </div>
          )}
          <MetaRow label="Updated" value={formatRelativeDate(task.updated_at)} />
        </div>

        {/* Agent controls */}
        <div className="px-4 py-3 border-b border-border/30 flex items-center gap-2">
          {canStart && (
            <button onClick={handleStart} className="bg-primary text-primary-foreground text-xs font-medium px-4 py-2 rounded-lg active:opacity-80">
              Start Agent
            </button>
          )}
          {canResume && (
            <button onClick={handleResume} className="bg-primary text-primary-foreground text-xs font-medium px-4 py-2 rounded-lg active:opacity-80">
              Resume Session
            </button>
          )}
          {canStop && (
            <button onClick={handleStop} className="bg-destructive text-primary-foreground text-xs font-medium px-4 py-2 rounded-lg active:opacity-80">
              Stop
            </button>
          )}
          {session && (
            <span className={`text-xs ml-auto ${
              session.status === 'working' ? 'text-green-400' :
              session.status === 'error' ? 'text-red-400' :
              session.status === 'waiting_approval' ? 'text-yellow-400' :
              'text-muted-foreground'
            }`}>
              {session.status === 'working' && '\u25CF Working'}
              {session.status === 'idle' && '\u25CB Idle'}
              {session.status === 'error' && '\u25CF Error'}
              {session.status === 'waiting_approval' && '\u25CF Waiting'}
            </span>
          )}
        </div>

        {/* Transcript preview */}
        {hasMessages && (
          <div className="px-4 py-3">
            <button
              onClick={() => onNavigate({ page: 'conversation', taskId })}
              className="w-full text-left"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-muted-foreground">Agent Transcript</span>
                <span className="text-xs text-primary">View all \u2192</span>
              </div>
            </button>
            <div className="space-y-2">
              {previewMessages.map((msg) => (
                <MessageBubble key={msg.id} message={msg} />
              ))}
            </div>
            {session!.messages.length > 3 && (
              <button
                onClick={() => onNavigate({ page: 'conversation', taskId })}
                className="w-full text-center text-xs text-primary mt-2 py-2 active:opacity-60"
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
    <div className="shrink-0 flex items-center gap-2 px-2 py-3 border-b border-border/30">
      <button onClick={onBack} className="p-2 active:opacity-60">
        <svg className="w-5 h-5 text-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m15 18-6-6 6-6" />
        </svg>
      </button>
      <h1 className="text-sm font-semibold truncate flex-1">{title}</h1>
    </div>
  )
}

function MetaRow({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-muted-foreground w-16 shrink-0">{label}</span>
      <span className={valueClass || 'text-foreground'}>{value}</span>
    </div>
  )
}
