import { remoteSyncLabel, runnerHarnessLabel, formatAge, type RemoteTaskState } from '@shared/enterprise-runners'

function lastSynced(state: RemoteTaskState, now: number): string {
  return state.lastSyncedAt ? `${formatAge(now - state.lastSyncedAt)} ago`.replace('now ago', 'just now') : 'not yet'
}

/** Runner chip, sync badge, state banners and the remote branch / PR summary. */
export function RemoteTaskBanner({ state, now = Date.now() }: { state: RemoteTaskState; now?: number }) {
  const completed = state.sync === 'completed-on-spaces'
  const branch = state.branch
  return (
    <div data-testid="remote-task-banner" className="space-y-2 px-4 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        {state.runnerName && (
          <span data-testid="runner-chip" className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5">
            ⛁ {state.runnerName}{state.harness ? ` · ${runnerHarnessLabel(state.harness)}` : ''}
          </span>
        )}
        <span data-testid="sync-badge" className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
          ⇄ {remoteSyncLabel(state.sync)} · {lastSynced(state, now)}
        </span>
        {state.webUrl && (
          <a href={state.webUrl} target="_blank" rel="noreferrer" className="ml-auto text-primary underline">↗ Open in Spaces</a>
        )}
      </div>

      {state.sync === 'runner-offline' && (
        <p data-testid="banner-runner-offline" className="rounded-md bg-yellow-500/10 p-2">
          <b>Runner offline</b> — {state.runnerName ?? 'the runner'} will continue when it’s back. Reassign it from the desktop app.
        </p>
      )}
      {state.sync === 'edited-on-web' && (
        <p data-testid="banner-edited-on-web" className="rounded-md bg-muted p-2">
          <b>Also open on web</b>{state.editedOnWebBy ? ` — ${state.editedOnWebBy} is active in Spaces` : ''}. Both messages are sent; the server orders them.
        </p>
      )}
      {completed && (
        <p data-testid="banner-completed" className="rounded-md bg-green-500/10 p-2">
          <b>Completed on Spaces</b>{state.completedBy ? ` by ${state.completedBy}` : ''}. 20x doesn’t complete synced tasks locally.
        </p>
      )}
      {state.sync === 'sync-paused' && (
        <p data-testid="banner-sync-paused" className="rounded-md bg-yellow-500/10 p-2">
          <b>Sync paused</b> — enterprise session expired. Sign in again on the desktop app.
        </p>
      )}

      {branch && (branch.branch || branch.prUrl) && (
        <div data-testid="remote-branch-panel" className="rounded-md border border-border p-2">
          <div className="font-medium">Remote branch / PR</div>
          {branch.branch && <div className="font-mono">{branch.branch}{branch.commitsAhead != null ? ` · ${branch.commitsAhead} commits ahead` : ''}</div>}
          <div className="mt-1 text-muted-foreground">No local diff — the working tree lives on the runner.</div>
          {branch.prUrl && (
            <a href={branch.prUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-primary underline">
              ↗ Open PR{branch.prNumber ? ` #${branch.prNumber}` : ''}
            </a>
          )}
        </div>
      )}
      {state.usageLine && <div className="text-muted-foreground">{state.usageLine}</div>}
    </div>
  )
}
