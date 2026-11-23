import type { RemoteTaskState } from '@shared/enterprise-runners'

export function makeRemote(over: Partial<RemoteTaskState> = {}): RemoteTaskState {
  return {
    taskId: 'task-1',
    serverTaskId: 'srv-1',
    remoteSessionId: 'sess-1',
    runnerId: 'r1',
    runnerName: 'studio-mac',
    harness: 'claude-code',
    sync: 'live',
    lastSyncedAt: Date.now() - 4000,
    sessionStatus: 'running',
    webUrl: 'https://app.peakflo.ai/tasks/srv-1',
    branch: {
      branch: 'fix/invoice-sync-race',
      repository: 'acme/billing',
      commitsAhead: 3,
      prUrl: 'https://github.com/acme/billing/pull/1942',
      prNumber: 1942,
      prState: 'open',
      ciState: 'passing',
      files: [
        { path: 'src/sync/worker.ts', additions: 12, deletions: 4 },
        { path: 'test/invoice-sync.spec.ts', additions: 20, deletions: 0 }
      ]
    },
    usageLine: '48k tokens · $0.61',
    ...over
  }
}
