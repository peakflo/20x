import { useMemo, useCallback, useState } from 'react'
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
  const updateTask = useTaskStore((s) => s.updateTask)
  const agents = useAgentStore((s) => s.agents)
  const skills = useAgentStore((s) => s.skills)
  const session = useAgentStore((s) => s.sessions.get(taskId))
  const initSession = useAgentStore((s) => s.initSession)
  const endSession = useAgentStore((s) => s.endSession)
  const clearMessageDedup = useAgentStore((s) => s.clearMessageDedup)

  const [skillsExpanded, setSkillsExpanded] = useState(false)
  const [repoInput, setRepoInput] = useState('')
  const [showRepoInput, setShowRepoInput] = useState(false)

  const agent = useMemo(() => agents.find((a) => a.id === task?.agent_id), [agents, task?.agent_id])

  // Session is already synced and running (from desktop or elsewhere)
  const isSessionRunning = session?.sessionId && (session.status === 'working' || session.status === 'waiting_approval')

  const handleAssignAgent = useCallback(async (agentId: string | null) => {
    if (!task) return
    await updateTask(task.id, { agent_id: agentId || null })
  }, [task, updateTask])

  const handleTriage = useCallback(async () => {
    if (!task || task.agent_id) return
    const defaultAgent = agents.find((a) => a.is_default) || agents[0]
    if (!defaultAgent) return
    try {
      await updateTask(task.id, { status: TaskStatus.Triaging })
      initSession(task.id, '', defaultAgent.id)
      const { sessionId } = await api.sessions.start(defaultAgent.id, task.id)
      initSession(task.id, sessionId, defaultAgent.id)
    } catch (e) {
      console.error('Failed to triage:', e)
      await updateTask(task.id, { status: TaskStatus.NotStarted })
    }
  }, [task, agents, updateTask, initSession])

  const handleUpdateSkillIds = useCallback(async (ids: string[] | null) => {
    if (!task) return
    await updateTask(task.id, { skill_ids: ids })
  }, [task, updateTask])

  const handleAddRepo = useCallback(async () => {
    if (!task || !repoInput.trim()) return
    const repo = repoInput.trim()
    if (task.repos.includes(repo)) { setRepoInput(''); return }
    await updateTask(task.id, { repos: [...task.repos, repo] })
    setRepoInput('')
    setShowRepoInput(false)
  }, [task, repoInput, updateTask])

  const handleRemoveRepo = useCallback(async (repo: string) => {
    if (!task) return
    await updateTask(task.id, { repos: task.repos.filter((r) => r !== repo) })
  }, [task, updateTask])

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
  const canTriage = !task.agent_id && agents.length > 0 && task.status !== TaskStatus.Completed && task.status !== TaskStatus.Triaging && !isSessionRunning
  const hasMessages = session && session.messages.length > 0

  // Preview: last 3 messages
  const previewMessages = session?.messages.slice(-3) || []

  // Skills available for this agent
  const agentSkills = useMemo(() => {
    if (!task.agent_id) return []
    return skills.filter((s) => !s.agent_id || s.agent_id === task.agent_id)
  }, [skills, task.agent_id])

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
              {session && (
                <span className={cn(
                  'text-xs flex items-center gap-1.5 ml-auto',
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
                {!showRepoInput && (
                  <button
                    onClick={() => setShowRepoInput(true)}
                    className="inline-flex items-center gap-1 h-6 px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
                  >
                    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14"/><path d="M12 5v14"/>
                    </svg>
                    Add
                  </button>
                )}
              </div>
              {showRepoInput && (
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={repoInput}
                    onChange={(e) => setRepoInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAddRepo(); if (e.key === 'Escape') { setShowRepoInput(false); setRepoInput('') } }}
                    placeholder="owner/repo"
                    autoFocus
                    className="flex-1 bg-transparent border border-border rounded px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring/30"
                  />
                  <button onClick={handleAddRepo} className="inline-flex items-center justify-center h-6 px-2 bg-primary text-primary-foreground rounded text-xs font-medium hover:bg-primary/90">
                    Add
                  </button>
                  <button onClick={() => { setShowRepoInput(false); setRepoInput('') }} className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent">
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
                    </svg>
                  </button>
                </div>
              )}
            </div>

            {/* Skills — visible when agent is assigned */}
            {task.agent_id && (
              <>
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
                  Skills
                </span>
                <div>
                  {task.skill_ids === null && !skillsExpanded ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Using agent defaults</span>
                      <button onClick={() => setSkillsExpanded(true)} className="text-xs text-primary active:opacity-60">
                        Customize
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-1.5">
                        {agentSkills.map((skill) => {
                          const selected = task.skill_ids === null || (task.skill_ids || []).includes(skill.id)
                          return (
                            <button
                              key={skill.id}
                              onClick={() => {
                                const current = task.skill_ids || agentSkills.map((s) => s.id)
                                const next = selected
                                  ? current.filter((id) => id !== skill.id)
                                  : [...current, skill.id]
                                handleUpdateSkillIds(next)
                              }}
                              className={cn(
                                'inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors',
                                selected
                                  ? 'bg-primary/20 border-primary/40 text-primary'
                                  : 'border-border/50 text-muted-foreground'
                              )}
                            >
                              {skill.name}
                            </button>
                          )
                        })}
                      </div>
                      {task.skill_ids !== null && (
                        <button
                          onClick={() => { handleUpdateSkillIds(null); setSkillsExpanded(false) }}
                          className="text-xs text-muted-foreground active:opacity-60"
                        >
                          Reset to defaults
                        </button>
                      )}
                    </div>
                  )}
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
          </div>
        </div>

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
