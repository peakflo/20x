import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { onEvent } from '../api/websocket'
import {
  CHILD_QUESTION_ANSWERED_CHANNEL,
  CHILD_QUESTION_ESCALATED_CHANNEL,
  CHILD_QUESTION_RAISED_CHANNEL,
  childQuestionStateLabel,
  type ChildQuestionRecord
} from '@shared/child-questions'

/** "Answered by the parent" means the parent agent — this app's branding term for that role. */
function answeredByLabel(record: ChildQuestionRecord): string | null {
  if (record.answeredBy === 'parent') return 'Answered by Mastermind'
  if (record.answeredBy === 'human') return 'Answered by you'
  return null
}

function answerSummary(record: ChildQuestionRecord): string | null {
  if (record.answer) return record.answer
  if (record.optionId) {
    const match = record.options?.find((opt) => opt.optionId === record.optionId)
    return match?.label ?? record.optionId
  }
  return null
}

/** A question routed to this task from one of its descendants — answerable here, or hand off to the human. */
function ParentQuestionCard({
  record,
  onUpdate
}: {
  record: ChildQuestionRecord
  onUpdate: (next: ChildQuestionRecord) => void
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [freeText, setFreeText] = useState('')
  const [note, setNote] = useState('')

  const actionable = record.state === 'pending_parent' || record.state === 'escalated'
  const canEscalate = record.state === 'pending_parent'
  const answeredBy = answeredByLabel(record)
  const summary = answerSummary(record)

  const submitAnswer = async (input: { approved?: boolean; answer?: string; optionId?: string }): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      // This card is shown on the phone for a human to tap — a human
      // decision, not the parent agent's own, even though it's shown on the
      // parent's task. `api.childQuestions.answer` speaks FOR the parent
      // (attributed "Answered by Mastermind") and only works while the item
      // is still pending_parent; answerAsHuman is the human's own path and
      // also works on an already-escalated item.
      const result = await api.childQuestions.answerAsHuman(record.childTaskId, record.questionId, input)
      if ('error' in result) setError(result.error)
      else onUpdate(result.record)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send the answer.')
    } finally {
      setPending(false)
    }
  }

  const submitEscalate = async (): Promise<void> => {
    if (!record.parentTaskId) return
    setPending(true)
    setError(null)
    try {
      const result = await api.childQuestions.escalate(record.parentTaskId, record.childTaskId, record.questionId, note.trim() || undefined)
      if ('error' in result) setError(result.error)
      else onUpdate(result.record)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to escalate.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      className={`rounded-lg border p-3 space-y-2 ${
        record.state === 'escalated' ? 'border-sky-500/40 bg-sky-500/10' : 'border-border/50 bg-card'
      }`}
      data-testid="child-question-card"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {childQuestionStateLabel(record.state)}
        </span>
        {record.requiresHuman && <span className="shrink-0 text-[10px] text-amber-500">Needs a human</span>}
      </div>
      <p className="text-sm text-foreground">{record.questionText}</p>
      {record.command && <p className="truncate font-mono text-[11px] text-muted-foreground">{record.command}</p>}

      {answeredBy ? (
        <p className="text-xs text-muted-foreground">
          {answeredBy}
          {summary ? `: ${summary}` : ''}
        </p>
      ) : actionable ? (
        <div className="space-y-2">
          {record.options && record.options.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {record.options.map((opt) => (
                <button
                  key={opt.optionId}
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    void submitAnswer(
                      record.kind === 'approval'
                        ? { approved: true, optionId: opt.optionId }
                        : { optionId: opt.optionId, answer: opt.label }
                    )
                  }
                  className="rounded-md border border-border/60 px-2.5 py-1.5 text-xs text-foreground active:bg-accent disabled:opacity-50"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          ) : record.kind === 'approval' ? (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => void submitAnswer({ approved: true })}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground active:opacity-80 disabled:opacity-50"
              >
                Approve
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => void submitAnswer({ approved: false })}
                className="rounded-md border border-border/60 px-3 py-1.5 text-xs text-foreground active:bg-accent disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                placeholder="Type an answer..."
                disabled={pending}
                className="h-8 flex-1 rounded-md border border-border/60 bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground"
              />
              <button
                type="button"
                disabled={pending || !freeText.trim()}
                onClick={() => void submitAnswer({ answer: freeText.trim() })}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground active:opacity-80 disabled:opacity-50"
              >
                Send
              </button>
            </div>
          )}
          {canEscalate && (
            <div className="flex items-center gap-2 border-t border-border/30 pt-2">
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional note"
                disabled={pending}
                className="h-7 flex-1 rounded-md border border-border/60 bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground"
              />
              <button
                type="button"
                disabled={pending}
                onClick={() => void submitEscalate()}
                className="shrink-0 text-xs text-primary disabled:opacity-50"
              >
                Escalate to me
              </button>
            </div>
          )}
        </div>
      ) : null}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}

/** A question this task itself raised for its own parent — read-only, since the human can't answer it on the task's behalf. */
function ChildQuestionCard({ record }: { record: ChildQuestionRecord }) {
  const answeredBy = answeredByLabel(record)
  const summary = answerSummary(record)
  return (
    <div className="space-y-1 rounded-lg border border-border/30 bg-card/60 p-3" data-testid="child-question-card-readonly">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {childQuestionStateLabel(record.state)}
      </span>
      <p className="text-sm text-foreground">{record.questionText}</p>
      {answeredBy && (
        <p className="text-xs text-muted-foreground">
          {answeredBy}
          {summary ? `: ${summary}` : ''}
        </p>
      )}
    </div>
  )
}

/**
 * Mobile counterpart of the desktop child-questions banner: live state of
 * every "children's questions go to the parent first" question touching
 * this task, in both directions.
 */
export function ChildQuestionsNotice({ taskId }: { taskId: string }) {
  const [asParent, setAsParent] = useState<ChildQuestionRecord[]>([])
  const [asChild, setAsChild] = useState<ChildQuestionRecord[]>([])

  const load = useCallback(() => {
    api.childQuestions.list(taskId)
      .then(({ as_parent, as_child }) => {
        setAsParent(as_parent)
        setAsChild(as_child)
      })
      .catch(() => undefined)
  }, [taskId])

  useEffect(() => {
    setAsParent([])
    setAsChild([])
    load()
    const offRaised = onEvent(CHILD_QUESTION_RAISED_CHANNEL, () => load())
    const offAnswered = onEvent(CHILD_QUESTION_ANSWERED_CHANNEL, () => load())
    const offEscalated = onEvent(CHILD_QUESTION_ESCALATED_CHANNEL, () => load())
    return () => {
      if (typeof offRaised === 'function') offRaised()
      if (typeof offAnswered === 'function') offAnswered()
      if (typeof offEscalated === 'function') offEscalated()
    }
  }, [taskId, load])

  const visibleAsParent = asParent.filter((r) => r.state !== 'cancelled')
  const visibleAsChild = asChild.filter((r) => r.state !== 'cancelled')

  if (visibleAsParent.length === 0 && visibleAsChild.length === 0) return null

  const updateParentRecord = (next: ChildQuestionRecord): void => {
    setAsParent((prev) => prev.map((r) => (r.id === next.id ? next : r)))
  }

  return (
    <div className="space-y-2 px-4 pt-3" data-testid="child-questions-notice">
      {visibleAsParent.map((record) => (
        <ParentQuestionCard key={record.id} record={record} onUpdate={updateParentRecord} />
      ))}
      {visibleAsChild.map((record) => (
        <ChildQuestionCard key={record.id} record={record} />
      ))}
    </div>
  )
}
