import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTaskStore } from '../stores/task-store'
import { useAgentStore, SessionStatus, type TaskSession } from '../stores/agent-store'
import { cn } from '../lib/utils'
import type { Route } from '../App'

/**
 * The mobile answer to the desktop's infinite canvas — there's no room for
 * floating panels on a phone, so instead of a literal port this gives the
 * same thing the canvas is actually for: seeing every agent working right
 * now, at a glance, without opening each task one at a time.
 */
export function ActiveSessionsPage({ onNavigate }: { onNavigate: (route: Route) => void }) {
  const tasks = useTaskStore((s) => s.tasks)
  const agents = useAgentStore((s) => s.agents)
  const sessions = useAgentStore(useShallow((s) => Array.from(s.sessions.values())))

  const cards = useMemo(() => {
    const taskById = new Map(tasks.map((t) => [t.id, t]))
    const agentById = new Map(agents.map((a) => [a.id, a]))

    return sessions
      .filter((s) => s.status !== SessionStatus.IDLE)
      .map((session) => {
        const task = taskById.get(session.taskId)
        const agent = agentById.get(session.agentId)
        const lastMessage = [...session.messages].reverse().find((m) => (!m.partType || m.partType === 'text') && m.content.trim())
        return { session, task, agent, lastMessage }
      })
      .filter((c) => c.task)
      // Working sessions first, then waiting-approval, then error — the ones
      // most likely to need attention float to the top.
      .sort((a, b) => statusRank(a.session.status) - statusRank(b.session.status))
  }, [tasks, agents, sessions])

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 px-4 pt-3 pb-2 border-b border-border/30">
        <h1 className="text-lg font-semibold">Active</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          {cards.length === 0 ? 'No agents running right now' : `${cards.length} agent${cards.length === 1 ? '' : 's'} running`}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {cards.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground px-8 text-center">
            <svg className="w-12 h-12 mb-3 opacity-20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" />
            </svg>
            <p className="text-sm">Nothing's running</p>
            <p className="text-xs mt-1 opacity-70">Agents you start will show up here live</p>
          </div>
        ) : (
          <div className="p-3 space-y-2.5">
            {cards.map(({ session, task, agent, lastMessage }) => (
              <button
                key={session.taskId}
                onClick={() => onNavigate({ page: 'conversation', taskId: session.taskId })}
                className="w-full text-left rounded-lg border border-border/40 bg-card p-3.5 active:bg-accent/40 transition-colors"
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <StatusPill status={session.status} />
                  {agent && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-muted-foreground truncate max-w-[40%]">
                      {agent.name}
                    </span>
                  )}
                </div>
                <div className="text-sm font-medium text-foreground truncate">{task!.title}</div>
                {lastMessage && (
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-snug">
                    {lastMessage.role === 'user' ? 'You: ' : ''}{lastMessage.content}
                  </p>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function statusRank(status: SessionStatus): number {
  switch (status) {
    case SessionStatus.WAITING_APPROVAL: return 0
    case SessionStatus.ERROR: return 1
    case SessionStatus.WORKING: return 2
    default: return 3
  }
}

function StatusPill({ status }: { status: TaskSession['status'] }) {
  const config: Record<SessionStatus, { label: string; className: string; dot: string }> = {
    [SessionStatus.WORKING]: { label: 'Working', className: 'text-amber-400 bg-amber-400/10', dot: 'bg-amber-400 animate-pulse' },
    [SessionStatus.WAITING_APPROVAL]: { label: 'Needs you', className: 'text-primary bg-primary/10', dot: 'bg-primary animate-pulse' },
    [SessionStatus.ERROR]: { label: 'Error', className: 'text-destructive bg-destructive/10', dot: 'bg-destructive' },
    [SessionStatus.IDLE]: { label: 'Idle', className: 'text-muted-foreground bg-muted', dot: 'bg-muted-foreground' }
  }
  const c = config[status]
  return (
    <span className={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium', c.className)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', c.dot)} />
      {c.label}
    </span>
  )
}
