import { useCallback, useEffect, useState } from 'react'
import { MessageCircleQuestion } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import {
  childQuestionsApi,
  onChildQuestionAnswered,
  onChildQuestionEscalated,
  onChildQuestionRaised
} from '@/lib/ipc-client'
import { childQuestionStateLabel, type ChildQuestionRecord } from '@shared/child-questions'

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

/**
 * One question/approval request raised by a descendant task and routed to
 * `taskId` as its parent — answerable within the parent's own authority, or
 * explicitly handed off to the human.
 */
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
    if (!record.parentTaskId) return
    setPending(true)
    setError(null)
    try {
      const result = await childQuestionsApi.answer(record.parentTaskId, record.childTaskId, record.questionId, input)
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
      const result = await childQuestionsApi.escalate(record.parentTaskId, record.childTaskId, record.questionId, note.trim() || undefined)
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
      className={`rounded-lg border px-3 py-2.5 space-y-2 ${
        record.state === 'escalated' ? 'border-sky-500/40 bg-sky-500/10' : 'border-border/50 bg-card'
      }`}
      data-testid="child-question-card"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {childQuestionStateLabel(record.state)}
          </span>
        </div>
        {record.requiresHuman && <span className="shrink-0 text-[10px] text-amber-500">Needs a human</span>}
      </div>
      <p className="text-xs text-foreground">{record.questionText}</p>
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
                <Button
                  key={opt.optionId}
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void submitAnswer(
                      record.kind === 'approval'
                        ? { approved: true, optionId: opt.optionId }
                        : { optionId: opt.optionId, answer: opt.label }
                    )
                  }
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          ) : record.kind === 'approval' ? (
            <div className="flex gap-1.5">
              <Button size="sm" disabled={pending} onClick={() => void submitAnswer({ approved: true })}>
                Approve
              </Button>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => void submitAnswer({ approved: false })}>
                Reject
              </Button>
            </div>
          ) : (
            <div className="flex gap-1.5">
              <Input
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                placeholder="Type an answer..."
                disabled={pending}
                className="h-8 text-xs"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && freeText.trim()) void submitAnswer({ answer: freeText.trim() })
                }}
              />
              <Button size="sm" disabled={pending || !freeText.trim()} onClick={() => void submitAnswer({ answer: freeText.trim() })}>
                Send
              </Button>
            </div>
          )}
          {canEscalate && (
            <div className="flex items-center gap-1.5 border-t border-border/30 pt-2">
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional note"
                disabled={pending}
                className="h-7 text-xs"
              />
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => void submitEscalate()}>
                Escalate to me
              </Button>
            </div>
          )}
        </div>
      ) : null}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}

/** A question `taskId` itself raised — read-only here; only the parent (or a direct human answer elsewhere) can resolve it. */
function ChildQuestionCard({ record }: { record: ChildQuestionRecord }) {
  const answeredBy = answeredByLabel(record)
  const summary = answerSummary(record)
  return (
    <div className="space-y-1 rounded-lg border border-border/30 bg-card/60 px-3 py-2.5" data-testid="child-question-card-readonly">
      <div className="flex items-center gap-1.5">
        <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {childQuestionStateLabel(record.state)}
        </span>
      </div>
      <p className="text-xs text-foreground">{record.questionText}</p>
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
 * Shown above a task's transcript: live state of every "children's questions
 * go to the parent first" question that touches this task, in both
 * directions — questions its own descendants routed to it (answerable here),
 * and the question it itself raised for its own parent (read-only).
 */
export function ChildQuestionsBanner({ taskId, floatingHeader = false }: { taskId: string; floatingHeader?: boolean }) {
  const [parentOf, setParentOf] = useState<ChildQuestionRecord[]>([])
  const [childOf, setChildOf] = useState<ChildQuestionRecord[]>([])

  const load = useCallback(() => {
    Promise.all([childQuestionsApi.listForParent(taskId), childQuestionsApi.listForChild(taskId)])
      .then(([parent, child]) => {
        setParentOf(parent)
        setChildOf(child)
      })
      .catch(() => undefined)
  }, [taskId])

  useEffect(() => {
    setParentOf([])
    setChildOf([])
    load()
    let offRaised: () => void = () => undefined
    let offAnswered: () => void = () => undefined
    let offEscalated: () => void = () => undefined
    try {
      offRaised = onChildQuestionRaised(() => load())
      offAnswered = onChildQuestionAnswered(() => load())
      offEscalated = onChildQuestionEscalated(() => load())
    } catch {
      // Live updates unavailable (e.g. tests without the bridge).
    }
    return () => {
      offRaised()
      offAnswered()
      offEscalated()
    }
  }, [taskId, load])

  const visibleParentOf = parentOf.filter((r) => r.state !== 'cancelled')
  const visibleChildOf = childOf.filter((r) => r.state !== 'cancelled')

  if (visibleParentOf.length === 0 && visibleChildOf.length === 0) return null

  const updateParentRecord = (next: ChildQuestionRecord): void => {
    setParentOf((prev) => prev.map((r) => (r.id === next.id ? next : r)))
  }

  return (
    <div
      className={`mx-3 ${floatingHeader ? 'mt-14' : 'mt-2'} space-y-2`}
      data-testid="child-questions-banner"
    >
      {visibleParentOf.map((record) => (
        <ParentQuestionCard key={record.id} record={record} onUpdate={updateParentRecord} />
      ))}
      {visibleChildOf.map((record) => (
        <ChildQuestionCard key={record.id} record={record} />
      ))}
    </div>
  )
}
