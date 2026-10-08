import { useMemo, useState } from 'react'
import { AlertTriangle, ArrowRight, GitPullRequest, Loader2, Mic, Plus, Send } from 'lucide-react'
import { useTaskStore } from '@/stores/task-store'
import { useAgentStore } from '@/stores/agent-store'
import { useUIStore } from '@/stores/ui-store'
import { agentSessionApi } from '@/lib/ipc-client'
import { captureAnalyticsEvent } from '@/lib/analytics'
import { useMastermindStore } from '@/stores/mastermind-store'
import { buildTodayModel, greetingFor, needsYouHeadline, type NeedsYouItem } from '@/lib/today-model'
import { cn } from '@/lib/utils'

const SECTION_LABEL = 'text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground'

function formatDue(due: string | null): string {
  if (!due) return 'No date'
  const date = new Date(due)
  const today = new Date()
  const days = Math.round(
    (new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() -
      new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
      86_400_000
  )
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days > 1 && days < 7) return date.toLocaleDateString(undefined, { weekday: 'short' })
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/**
 * The Calm Desk home: what needs you, what agents are doing, and what is
 * next, in that order. Shown instead of the Legacy dashboard when the Calm
 * Desk layout is chosen.
 */
export function TodayHome() {
  const tasks = useTaskStore((s) => s.tasks)
  const sessions = useAgentStore((s) => s.sessions)
  const agents = useAgentStore((s) => s.agents)
  const openPreview = useUIStore((s) => s.openDashboardPreview)
  const setShowOrchestrator = useUIStore((s) => s.setShowOrchestrator)
  const openCreateWithPrefill = useUIStore((s) => s.openCreateWithPrefill)
  const setSidebarView = useUIStore((s) => s.setSidebarView)
  const [question, setQuestion] = useState('')
  const assistantName = useMastermindStore((s) => s.assistantName)
  const [answering, setAnswering] = useState<Set<string>>(new Set())

  const sessionList = useMemo(
    () =>
      [...sessions.values()].map((session) => ({
        taskId: session.taskId,
        sessionId: session.sessionId,
        status: session.status,
        pendingApproval: session.pendingApproval
      })),
    [sessions]
  )
  const model = useMemo(() => buildTodayModel(tasks, sessionList), [tasks, sessionList])
  const agentName = (id: string | null) => agents.find((agent) => agent.id === id)?.name ?? 'An agent'
  const now = new Date()

  const askPeako = (text: string) => {
    const message = text.trim()
    if (!message) return
    setShowOrchestrator(true)
    void useMastermindStore.getState().send?.(message).catch(console.error)
    setQuestion('')
  }

  const answer = async (item: Extract<NeedsYouItem, { kind: 'approval' }>, approved: boolean) => {
    setAnswering((prev) => new Set(prev).add(item.sessionId))
    try {
      await agentSessionApi.approve(item.sessionId, approved)
      captureAnalyticsEvent('agent_approval_responded', {
        task_id: item.taskId,
        session_id: item.sessionId,
        approved,
        has_message: false,
        source: 'today_home'
      })
    } catch (error) {
      console.error('[TodayHome] Failed to answer approval:', error)
    } finally {
      setAnswering((prev) => {
        const next = new Set(prev)
        next.delete(item.sessionId)
        return next
      })
    }
  }

  const suggestions = [
    model.needsYou.find((item) => item.kind === 'review') &&
      `Summarise what changed in "${model.needsYou.find((item) => item.kind === 'review')!.title}"`,
    model.upNext[0] && `Start "${model.upNext[0].title}"`,
    'What did the agents do today?'
  ].filter((text): text is string => Boolean(text))

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="mx-auto grid max-w-[1180px] grid-cols-1 gap-10 px-8 pt-10 pb-12 lg:grid-cols-[minmax(0,1fr)_320px]">
        <main className="flex min-w-0 flex-col gap-8">
          <header className="flex flex-col gap-1.5">
            <span className={SECTION_LABEL}>
              {now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
            </span>
            <h1 className="text-[32px] font-bold leading-tight tracking-[-0.02em] text-balance text-foreground">
              {greetingFor(now)} {needsYouHeadline(model.needsYou.length)}
            </h1>
          </header>

          {model.needsYou.length > 0 && (
            <section aria-labelledby="today-needs" className="flex flex-col gap-2.5">
              <h2 id="today-needs" className="text-[12px] font-semibold uppercase tracking-[0.06em] text-foreground">
                Needs you
              </h2>
              {model.needsYou.map((item) => (
                <article
                  key={`${item.kind}-${item.taskId}`}
                  className="flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-3.5 shadow-card"
                >
                  <span
                    className={cn(
                      'grid h-9 w-9 shrink-0 place-items-center rounded-md',
                      item.kind === 'review' ? 'bg-primary/10 text-primary' : 'bg-warning/20 text-foreground'
                    )}
                  >
                    {item.kind === 'review' ? <GitPullRequest className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                  </span>
                  <button
                    type="button"
                    onClick={() => openPreview(item.taskId)}
                    className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-left"
                  >
                    <span className="truncate text-[14px] font-semibold text-foreground">
                      {item.kind === 'review' ? `Review: ${item.title}` : item.kind === 'overdue' ? item.title : `${item.title}`}
                    </span>
                    <span className="truncate text-[13px] text-muted-foreground">
                      {item.kind === 'approval' && `Wants to ${item.action || 'continue'}`}
                      {item.kind === 'review' && `${agentName(item.agentId)} finished${item.overdue ? ' · overdue' : ''}`}
                      {item.kind === 'overdue' && 'Overdue and not started'}
                    </span>
                  </button>
                  {item.kind === 'approval' ? (
                    <span className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        disabled={answering.has(item.sessionId)}
                        onClick={() => void answer(item, false)}
                        className="h-9 cursor-pointer rounded-md border border-border bg-card px-3.5 text-[14px] font-semibold text-foreground hover:bg-accent disabled:opacity-50"
                      >
                        Not now
                      </button>
                      <button
                        type="button"
                        disabled={answering.has(item.sessionId)}
                        onClick={() => void answer(item, true)}
                        className="h-9 cursor-pointer rounded-md bg-foreground px-4 text-[14px] font-semibold text-background hover:opacity-90 disabled:opacity-50"
                      >
                        Allow
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => openPreview(item.taskId)}
                      className="h-9 shrink-0 cursor-pointer rounded-md bg-primary px-4 text-[14px] font-semibold text-primary-foreground hover:opacity-90"
                    >
                      {item.kind === 'review' ? 'Review' : 'Open'}
                    </button>
                  )}
                </article>
              ))}
            </section>
          )}

          <section aria-labelledby="today-running" className="flex flex-col">
            <h2 id="today-running" className={cn(SECTION_LABEL, 'mb-2')}>Agents are on it</h2>
            {model.running.length === 0 ? (
              <p className="py-3 text-[14px] text-muted-foreground">No agent is working right now.</p>
            ) : (
              model.running.map((item) => (
                <button
                  key={item.taskId}
                  type="button"
                  onClick={() => openPreview(item.taskId)}
                  className="flex cursor-pointer items-center gap-3.5 border-b border-border px-1.5 py-3 text-left hover:bg-accent/40"
                >
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                  <span className="min-w-0 flex-1 truncate text-[14px] text-foreground">{item.title}</span>
                  <span className="shrink-0 text-[13px] text-muted-foreground">
                    {item.status === 'triaging' ? 'Sorting it out' : agentName(item.agentId)}
                  </span>
                </button>
              ))
            )}
          </section>

          <section aria-labelledby="today-next" className="flex flex-col">
            <div className="mb-2 flex items-center justify-between">
              <h2 id="today-next" className={SECTION_LABEL}>Up next</h2>
              <button
                type="button"
                onClick={() => setSidebarView('tasks')}
                className="flex cursor-pointer items-center gap-1 text-[13px] font-medium text-primary hover:underline"
              >
                All tasks <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
            {model.upNext.length === 0 ? (
              <p className="py-3 text-[14px] text-muted-foreground">Nothing waiting. Add a task to get started.</p>
            ) : (
              model.upNext.map((item) => (
                <button
                  key={item.taskId}
                  type="button"
                  onClick={() => openPreview(item.taskId)}
                  className="flex cursor-pointer items-center gap-3.5 border-b border-border px-1.5 py-3 text-left hover:bg-accent/40"
                >
                  <span className="h-4 w-4 shrink-0 rounded-full border-2 border-muted-foreground/50" />
                  <span className="min-w-0 flex-1 truncate text-[14px] text-foreground">{item.title}</span>
                  <span className="shrink-0 text-[13px] capitalize text-muted-foreground">{item.priority}</span>
                  <span className="w-20 shrink-0 text-right text-[13px] text-muted-foreground">{formatDue(item.due)}</span>
                </button>
              ))
            )}
            <button
              type="button"
              onClick={() => openCreateWithPrefill('')}
              className="mt-2 flex cursor-pointer items-center gap-2 self-start rounded-md px-1.5 py-2 text-[14px] font-medium text-muted-foreground hover:text-foreground"
            >
              <Plus className="h-4 w-4" /> New task
            </button>
          </section>
        </main>

        <aside aria-label={`Ask ${assistantName} and totals`} className="flex min-w-0 flex-col gap-4">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              askPeako(question)
            }}
            className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-card"
          >
            <label htmlFor="today-ask" className="text-[14px] font-semibold text-foreground">
              Ask {assistantName}
            </label>
            <textarea
              id="today-ask"
              rows={2}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  askPeako(question)
                }
              }}
              placeholder="What did the agents do this morning?"
              className="resize-none rounded-md border border-input bg-background px-3 py-2 text-[14px] text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none"
            />
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((text) => (
                <button
                  key={text}
                  type="button"
                  onClick={() => askPeako(text)}
                  className="max-w-full cursor-pointer truncate rounded-full bg-primary/10 px-3 py-1 text-[13px] font-medium text-primary hover:bg-primary/15"
                >
                  {text}
                </button>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowOrchestrator(true)}
                aria-label={`Open the ${assistantName} chat`}
                className="grid h-8 w-8 cursor-pointer place-items-center rounded-md border border-border text-muted-foreground hover:text-foreground"
              >
                <Mic className="h-4 w-4" />
              </button>
              <button
                type="submit"
                disabled={!question.trim()}
                className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 text-[14px] font-semibold text-primary-foreground disabled:opacity-40"
              >
                <Send className="h-3.5 w-3.5" /> Ask
              </button>
            </div>
          </form>

          <section aria-labelledby="today-glance" className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-card">
            <h2 id="today-glance" className="text-[14px] font-semibold text-foreground">At a glance</h2>
            <dl className="grid grid-cols-2 gap-3">
              {[
                { label: 'Need you', value: model.needsYou.length },
                { label: 'Running', value: model.running.length },
                { label: 'Not started', value: model.totals.notStarted },
                { label: 'Done', value: model.totals.completed }
              ].map((stat) => (
                <div key={stat.label} className="flex flex-col gap-0.5 rounded-md bg-muted px-3 py-2.5">
                  <dt className="text-[12px] text-muted-foreground">{stat.label}</dt>
                  <dd className="text-[22px] font-semibold tabular-nums text-foreground">{stat.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </aside>
      </div>
    </div>
  )
}
