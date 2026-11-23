import { useEffect, useState } from 'react'
import { approvalCountdown, filterApprovalOptions } from '@shared/enterprise-runners'

export interface RemoteApprovalRequest {
  requestId?: string
  kind: 'approval' | 'question'
  /** Command or question text. */
  text: string
  /** Question options from the runner; ignored for approvals (Allow / Reject only). */
  options?: Array<{ id?: string; label: string }>
  runnerName?: string | null
  requestedAtMs: number
  answered?: boolean
}

interface Props {
  request: RemoteApprovalRequest
  onAllow: () => void
  onReject: () => void
  onPick: (label: string) => void
  /** Injectable clock for tests. */
  now?: () => number
}

export function RemoteApprovalCard({ request, onAllow, onReject, onPick, now = Date.now }: Props) {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])
  const countdown = approvalCountdown(request.requestedAtMs, !!request.answered, now())
  const expired = countdown.state === 'expired'
  const options = filterApprovalOptions(request.options ?? [])

  return (
    <div
      data-testid="remote-approval-card"
      className={`mx-4 my-2 rounded-xl border p-3 text-sm ${expired ? 'border-border bg-muted/40' : 'border-yellow-500/40 bg-yellow-500/10'}`}
    >
      <div className="mb-1 flex items-center justify-between gap-2 text-xs font-semibold">
        <span>{expired ? 'Approval expired' : request.kind === 'approval' ? 'Approval needed' : 'Question'}{request.runnerName ? ` · from ${request.runnerName}` : ''}</span>
        {countdown.state === 'pending' && (
          <span data-testid="approval-countdown" className="tabular-nums text-muted-foreground">⏱ auto-denied in {countdown.label}</span>
        )}
      </div>
      <pre className="mb-2 whitespace-pre-wrap break-words rounded-md bg-background/60 p-2 font-mono text-xs">{request.text}</pre>
      {expired ? (
        <p className="text-xs text-muted-foreground">Denied · timed out. The runner continued without this action. Ask the agent to try again if you still want it.</p>
      ) : request.kind === 'approval' ? (
        <div className="flex gap-2">
          <button type="button" onClick={onAllow} className="h-9 flex-1 rounded-md bg-primary text-sm font-medium text-primary-foreground">Allow</button>
          <button type="button" onClick={onReject} className="h-9 flex-1 rounded-md border border-border text-sm font-medium">Reject</button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {options.map((o) => (
            <button key={o.id ?? o.label} type="button" onClick={() => onPick(o.label)} className="h-9 rounded-md border border-border px-3 text-sm font-medium">{o.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}
