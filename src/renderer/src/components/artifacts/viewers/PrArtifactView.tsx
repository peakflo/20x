import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CircleCheck,
  CircleDot,
  CircleX,
  ExternalLink,
  Files,
  GitCommitHorizontal,
  GitPullRequest,
  Loader2,
  MessageSquare,
  RefreshCw,
  UserRoundCheck
} from 'lucide-react'
import { Badge, type BadgeVariant } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import {
  PullRequestCheckState,
  PullRequestReviewDecision,
  PullRequestState,
  type Artifact,
  type PullRequestDetails
} from '@shared/artifacts'

function statePresentation(details: PullRequestDetails): { label: string; variant: BadgeVariant } {
  if (details.isDraft) return { label: 'Draft', variant: 'default' }
  if (details.state === PullRequestState.MERGED) return { label: 'Merged', variant: 'pink' }
  if (details.state === PullRequestState.CLOSED) return { label: 'Closed', variant: 'red' }
  return { label: 'Open', variant: 'green' }
}

function reviewLabel(decision: PullRequestReviewDecision): string {
  switch (decision) {
    case PullRequestReviewDecision.APPROVED: return 'Approved'
    case PullRequestReviewDecision.CHANGES_REQUESTED: return 'Changes requested'
    case PullRequestReviewDecision.REVIEW_REQUIRED: return 'Review required'
    default: return 'No review decision'
  }
}

function CheckIcon({ state }: { state: PullRequestCheckState }) {
  if (state === PullRequestCheckState.PASSED) return <CircleCheck className="h-3.5 w-3.5 text-emerald-500" />
  if (state === PullRequestCheckState.FAILED) return <CircleX className="h-3.5 w-3.5 text-destructive" />
  if (state === PullRequestCheckState.SKIPPED) return <CircleDot className="h-3.5 w-3.5 text-muted-foreground" />
  return <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />
}

export function PrArtifactView({ artifact }: { artifact: Artifact }) {
  const [details, setDetails] = useState<PullRequestDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    if (!artifact.url) {
      setLoading(false)
      setError('Pull request URL is unavailable.')
      return
    }
    setLoading(true)
    setError(null)
    void window.electronAPI.github.fetchPullRequestDetails(artifact.url).then((result) => {
      if (!cancelled) setDetails(result)
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [artifact.url, artifact.reloadTrigger, refreshKey])

  const checkSummary = useMemo(() => {
    const checks = details?.checks || []
    return {
      passed: checks.filter((check) => check.state === PullRequestCheckState.PASSED).length,
      failed: checks.filter((check) => check.state === PullRequestCheckState.FAILED).length,
      pending: checks.filter((check) => check.state === PullRequestCheckState.PENDING).length
    }
  }, [details?.checks])

  if (loading) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading pull request…</div>
  }

  if (error || !details) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-md rounded-lg border border-border/50 bg-card p-5 text-center">
          <AlertTriangle className="mx-auto h-5 w-5 text-destructive" />
          <p className="mt-2 text-sm text-foreground">Couldn’t load pull request details</p>
          <p className="mt-1 text-xs text-muted-foreground">{error || 'The pull request is unavailable.'}</p>
          <div className="mt-4 flex justify-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setRefreshKey((value) => value + 1)}><RefreshCw className="h-3.5 w-3.5" />Retry</Button>
            {artifact.url && <Button type="button" size="sm" onClick={() => window.electronAPI.shell.openExternal(artifact.url!)}><ExternalLink className="h-3.5 w-3.5" />Open</Button>}
          </div>
        </div>
      </div>
    )
  }

  const state = statePresentation(details)
  return (
    <div className="h-full overflow-auto bg-background p-4 sm:p-6">
      <div className="mx-auto w-full max-w-3xl overflow-hidden rounded-xl border border-border/50 bg-card shadow-sm">
        <div className="border-b border-border/50 p-5">
          <div className="flex items-start gap-3">
            <GitPullRequest className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">{details.repository} #{details.number}</span>
                <Badge variant={state.variant}>{state.label}</Badge>
              </div>
              <h2 className="mt-1 text-base font-semibold leading-snug text-foreground">{details.title}</h2>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  {details.author.avatarUrl
                    ? <img src={details.author.avatarUrl} alt="" className="h-4 w-4 rounded-full" />
                    : <GitCommitHorizontal className="h-3.5 w-3.5" />}
                  {details.author.login}
                </span>
                <span className="inline-flex min-w-0 items-center gap-1 font-mono">
                  <span className="max-w-40 truncate rounded bg-muted px-1.5 py-0.5">{details.headRefName}</span>
                  <ArrowRight className="h-3 w-3 shrink-0" />
                  <span className="max-w-40 truncate rounded bg-muted px-1.5 py-0.5">{details.baseRefName}</span>
                </span>
              </div>
            </div>
            <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={() => window.electronAPI.shell.openExternal(details.url)}><ExternalLink className="h-3.5 w-3.5" />Open</Button>
          </div>
          {details.body && <p className="mt-4 line-clamp-4 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{details.body}</p>}
        </div>

        <div className="grid grid-cols-2 divide-x divide-y divide-border/50 border-b border-border/50 sm:grid-cols-4 sm:divide-y-0">
          <div className="p-3 text-center"><div className="text-sm font-semibold text-foreground">{details.changedFiles}</div><div className="mt-0.5 text-[11px] text-muted-foreground">files changed</div></div>
          <div className="p-3 text-center"><div className="text-sm font-semibold"><span className="text-emerald-500">+{details.additions}</span> <span className="text-destructive">−{details.deletions}</span></div><div className="mt-0.5 text-[11px] text-muted-foreground">lines</div></div>
          <div className="p-3 text-center"><div className="text-sm font-semibold text-foreground">{details.reviewsCount}</div><div className="mt-0.5 text-[11px] text-muted-foreground">reviews</div></div>
          <div className="p-3 text-center"><div className="text-sm font-semibold text-foreground">{details.commentsCount}</div><div className="mt-0.5 text-[11px] text-muted-foreground">comments</div></div>
        </div>

        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <section>
            <h3 className="flex items-center gap-2 text-xs font-medium text-foreground"><UserRoundCheck className="h-4 w-4 text-muted-foreground" />Review</h3>
            <div className="mt-2 flex items-center gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2.5 text-xs">
              {details.reviewDecision === PullRequestReviewDecision.APPROVED && <Check className="h-4 w-4 text-emerald-500" />}
              {details.reviewDecision === PullRequestReviewDecision.CHANGES_REQUESTED && <CircleX className="h-4 w-4 text-destructive" />}
              {details.reviewDecision !== PullRequestReviewDecision.APPROVED && details.reviewDecision !== PullRequestReviewDecision.CHANGES_REQUESTED && <MessageSquare className="h-4 w-4 text-muted-foreground" />}
              <span className="text-foreground">{reviewLabel(details.reviewDecision)}</span>
            </div>
          </section>

          <section>
            <h3 className="flex items-center gap-2 text-xs font-medium text-foreground"><Files className="h-4 w-4 text-muted-foreground" />Checks</h3>
            <div className="mt-2 rounded-lg border border-border/50 bg-muted/30">
              {details.checks.length === 0 ? (
                <div className="px-3 py-2.5 text-xs text-muted-foreground">No checks reported</div>
              ) : (
                <>
                  <div className="flex gap-3 border-b border-border/50 px-3 py-2 text-[11px] text-muted-foreground">
                    <span className="text-emerald-500">{checkSummary.passed} passed</span>
                    {checkSummary.failed > 0 && <span className="text-destructive">{checkSummary.failed} failed</span>}
                    {checkSummary.pending > 0 && <span className="text-amber-500">{checkSummary.pending} pending</span>}
                  </div>
                  <div className="divide-y divide-border/40">
                    {details.checks.slice(0, 5).map((check, index) => (
                      <div key={`${check.name}:${index}`} className="flex items-center gap-2 px-3 py-2 text-xs">
                        <CheckIcon state={check.state} />
                        <span className="min-w-0 flex-1 truncate text-foreground">{check.name}</span>
                      </div>
                    ))}
                    {details.checks.length > 5 && <div className="px-3 py-2 text-[11px] text-muted-foreground">+{details.checks.length - 5} more checks</div>}
                  </div>
                </>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
