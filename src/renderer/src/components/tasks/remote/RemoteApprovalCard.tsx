import { useContext, useState } from 'react'
import { ShieldAlert, Timer } from 'lucide-react'
import { approvalCountdown, classifyApprovalOption, filterApprovalOptions } from '@shared/enterprise-runners'
import { useNow } from '@/hooks/use-now'
import { RemoteDecisionContext } from '@/hooks/use-remote-task-state'
import { cn } from '@/lib/utils'
import type { AgentMessage } from '@/hooks/use-agent-session'

/**
 * Approval / question card for a session that runs on a Spaces runner.
 * Permission requests offer Allow / Reject only (never "always allow");
 * unanswered requests are auto-denied by the server after 30 minutes.
 */
export function RemoteApprovalCard({ message, canAnswer, onAnswer }: {
  message: AgentMessage
  canAnswer: boolean
  onAnswer?: (answer: string) => void
}) {
  const decide = useContext(RemoteDecisionContext)
  const [submitted, setSubmitted] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const questions = message.tool?.questions ?? []
  const isPermission = message.tool?.name === 'permission'
  const answered = submitted !== null || !canAnswer
  const now = useNow(!answered)
  const countdown = approvalCountdown(message.timestamp.getTime(), answered, now)
  const expired = countdown.state === 'expired'
  const locked = answered || expired
  const unit = isPermission ? 'request' : 'question'

  const send = (label: string): void => {
    if (locked) return
    setSubmitted(label)
    onAnswer?.(label)
  }

  if (isPermission) {
    const q = questions[0]
    const options = filterApprovalOptions(q?.options ?? [])
    const allow = options.find((o) => classifyApprovalOption(o) === 'allow')
    const reject = options.find((o) => classifyApprovalOption(o) === 'reject')
    const decideWith = (approved: boolean, label: string): void => {
      if (locked) return
      setSubmitted(label)
      if (decide) decide({ approved, requestId: message.tool?.requestId, label })
      else onAnswer?.(label)
    }
    const command = message.tool?.description || message.tool?.title || q?.question || message.content
    return (
      <div className={cn('overflow-hidden rounded-md border bg-card', expired ? 'border-red-500/30' : 'border-amber-500/40')} data-testid="remote-approval-card">
        <div className="space-y-2 px-4 py-3">
          <div className="flex items-center gap-2 text-xs font-medium text-foreground">
            <ShieldAlert className={cn('h-3.5 w-3.5', expired ? 'text-red-400' : 'text-amber-500')} />
            {expired ? 'Approval expired' : 'Approval needed'}
            <span className="font-normal text-muted-foreground">from the runner · answer here or in Spaces</span>
          </div>
          <pre className="whitespace-pre-wrap break-all rounded bg-muted/50 px-2 py-1.5 font-mono text-[11px] text-foreground">{command}</pre>
          {expired ? (
            <p className="text-[11px] text-muted-foreground">
              <strong className="text-foreground">Denied · timed out</strong> — no answer in 30 min. The runner continued without this action. Ask the agent to try again if you still want it.
            </p>
          ) : submitted ? (
            <p className="text-[11px] text-muted-foreground">Answered: <strong className="text-foreground">{submitted}</strong></p>
          ) : null}
          <div className="flex items-center gap-2">
            <button type="button" disabled={locked || !allow} onClick={() => allow && decideWith(true, allow.label)} className="rounded-md bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-40">Allow</button>
            <button type="button" disabled={locked || !reject} onClick={() => reject && decideWith(false, reject.label)} className="rounded-md border border-red-500/50 px-3 py-1 text-xs font-medium text-red-400 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40">Reject</button>
            {countdown.state === 'pending' && (
              <span className="ml-auto inline-flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground" data-testid="approval-countdown">
                <Timer className="h-3 w-3" />auto-denied in {countdown.label}
              </span>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">Options come from the runner (allow / reject only). An unanswered {unit} is denied after 30 minutes.</p>
        </div>
      </div>
    )
  }

  const allAnswered = questions.every((_, i) => answers[i]?.trim())
  return (
    <div className={cn('overflow-hidden rounded-md border bg-card', expired ? 'border-red-500/30' : 'border-primary/30')} data-testid="remote-question-card">
      {questions.map((q, qi) => (
        <div key={qi} className="space-y-2 px-4 py-3">
          {q.header && <span className="text-[10px] font-medium uppercase tracking-wide text-primary">{q.header}</span>}
          <p className="text-xs text-foreground">{q.question}</p>
          {q.options?.length ? (
            <div className="space-y-1.5">
              {filterApprovalOptions(q.options).map((opt, oi) => (
                <button
                  key={oi}
                  type="button"
                  disabled={locked}
                  onClick={() => (questions.length === 1 ? send(opt.label) : setAnswers((a) => ({ ...a, [qi]: opt.label })))}
                  className={cn('w-full rounded border px-3 py-2 text-left text-xs', answers[qi] === opt.label ? 'border-primary/50 bg-primary/20' : 'border-border/50 hover:bg-accent', locked && 'cursor-default opacity-50')}
                >
                  <span className="font-medium">{opt.label}</span>
                  {opt.description && <span className="mt-0.5 block text-[11px] text-muted-foreground">{opt.description}</span>}
                </button>
              ))}
            </div>
          ) : (
            <input
              type="text"
              disabled={locked}
              value={answers[qi] ?? ''}
              onChange={(e) => setAnswers((a) => ({ ...a, [qi]: e.target.value }))}
              placeholder="Type your answer..."
              className="w-full rounded border border-border/50 bg-input px-3 py-2 text-xs"
            />
          )}
        </div>
      ))}
      {questions.length > 1 || questions.some((q) => !q.options?.length) ? (
        <div className="border-t border-border/30 px-4 py-2">
          <button type="button" disabled={locked || !allAnswered} onClick={() => send(questions.map((q, i) => (questions.length === 1 ? answers[i] : `${q.header || q.question}: ${answers[i]}`)).join('\n'))} className="rounded bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground disabled:bg-muted disabled:text-muted-foreground">Submit</button>
        </div>
      ) : null}
      <div className="flex items-center gap-2 px-4 pb-2 text-[10px] text-muted-foreground">
        {expired ? <span className="text-red-400">Question expired — denied · timed out</span> : countdown.state === 'pending' ? (
          <span className="inline-flex items-center gap-1 tabular-nums" data-testid="approval-countdown"><Timer className="h-3 w-3" />times out in {countdown.label}</span>
        ) : submitted ? <span>Answered</span> : null}
        <span className="ml-auto">Unanswered questions also time out after 30 minutes.</span>
      </div>
    </div>
  )
}
