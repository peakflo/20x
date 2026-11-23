import { useState } from 'react'
import { ArrowUpRight, CheckCircle2, CloudDownload, GitBranch, GitPullRequest, Loader2, XCircle } from 'lucide-react'
import type { RemoteTaskState } from '@shared/enterprise-runners'
import { enterpriseRunnersApi } from '@/lib/ipc-client'
import { Button } from '@/components/ui/Button'
import { openInSpaces } from './RemoteChips'

/** Replaces the local diff for tasks whose working tree lives on a runner. */
export function RemoteBranchPanel({ taskId, state, className }: { taskId: string; state: RemoteTaskState; className?: string }) {
  const branch = state.branch
  const [fetching, setFetching] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const openLocally = async (): Promise<void> => {
    setFetching(true)
    setResult(null)
    try {
      const res = await enterpriseRunnersApi.openLocally(taskId)
      setResult(res.ok ? { ok: true, text: `Fetched into ${res.worktreePath ?? 'a local worktree'}. The task stays on the runner.` } : { ok: false, text: res.error ?? 'Could not fetch the branch.' })
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setFetching(false)
    }
  }

  return (
    <div className={`flex h-full min-h-0 flex-col overflow-y-auto p-4 ${className ?? ''}`} data-testid="remote-branch-panel">
      <div className="flex items-center gap-2 text-sm font-medium">
        <GitBranch className="h-4 w-4 text-muted-foreground" />
        <span className="truncate font-mono text-xs">{branch?.branch ?? 'No branch yet'}</span>
        {branch?.prUrl && (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
            <GitPullRequest className="h-3 w-3" />PR #{branch.prNumber} {branch.prState ?? 'open'}
          </span>
        )}
        {branch?.ciState && (
          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
            {branch.ciState === 'passing' ? <CheckCircle2 className="h-3 w-3 text-emerald-500" /> : branch.ciState === 'failing' ? <XCircle className="h-3 w-3 text-red-400" /> : <Loader2 className="h-3 w-3" />}CI {branch.ciState === 'passing' ? '✓' : branch.ciState}
          </span>
        )}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        on {state.runnerName ?? 'the runner'}{branch?.commitsAhead != null ? ` · ${branch.commitsAhead} commit${branch.commitsAhead === 1 ? '' : 's'} ahead of main` : ''}
      </p>
      {branch && branch.files.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Changed files</div>
          <ul className="divide-y divide-border/40 rounded-md border border-border/50">
            {branch.files.map((f) => (
              <li key={f.path} className="flex items-center gap-2 px-3 py-1.5 font-mono text-[11px]">
                <span className="min-w-0 flex-1 truncate">{f.path}</span>
                <span className="text-emerald-500">+{f.additions}</span>
                {f.deletions > 0 && <span className="text-red-400">−{f.deletions}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-3 rounded-md border border-dashed border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
        No local diff — the working tree lives on the runner.
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void openLocally()} disabled={fetching || !branch?.branch}>
          {fetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CloudDownload className="h-3.5 w-3.5" />}Open locally (fetch branch)
        </Button>
        {branch?.prUrl && (
          <Button size="sm" variant="outline" onClick={() => openInSpaces(branch.prUrl)}>
            <ArrowUpRight className="h-3.5 w-3.5" />Open PR
          </Button>
        )}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Runs <code className="font-mono">git fetch origin {branch?.branch ?? '<branch>'}</code> into a local worktree. The task stays on the runner.
      </p>
      {result && <p role={result.ok ? 'status' : 'alert'} className={`mt-2 text-[11px] ${result.ok ? 'text-emerald-500' : 'text-red-400'}`}>{result.text}</p>}
      <div className="mt-auto flex items-center gap-3 pt-4 text-[11px] text-muted-foreground">
        <span>🔒 {state.runnerName ?? 'runner'}</span>
        <span>Live · mirrored with Spaces</span>
        {state.usageLine && <span className="ml-auto" data-testid="usage-line">{state.usageLine}</span>}
      </div>
    </div>
  )
}
