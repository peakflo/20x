import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WorkspaceCleanupScheduler } from './workspace-cleanup-scheduler'
import type { DatabaseManager, TaskRecord } from './database'
import { TaskStatus } from '../shared/constants'
import { runWorkspaceCleanupWorker } from './workspace-cleanup-worker-client'

vi.mock('./workspace-cleanup-worker-client', () => ({ runWorkspaceCleanupWorker: vi.fn() }))
vi.mock('./workspace-paths', () => ({ WORKSPACES_DIR: '/test/workspaces', REPOS_DIR: '/test/repos', listWorkspaceDirs: () => [] }))
vi.mock('./workspace-process-cleanup', () => ({ readDiskSpace: () => null, workspacePressureWarning: () => null }))

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { id: 'task-1', status: TaskStatus.Completed, ...overrides } as TaskRecord
}

function mockDbManager(tasks: TaskRecord[] = []): DatabaseManager {
  const settings: Record<string, string> = {}
  return {
    getTasks: vi.fn(() => tasks),
    getSetting: vi.fn((key: string) => settings[key]),
    setSetting: vi.fn((key: string, value: string) => { settings[key] = value })
  } as unknown as DatabaseManager
}

describe('WorkspaceCleanupScheduler', () => {
  let scheduler: WorkspaceCleanupScheduler
  let db: DatabaseManager
  const runWorker = vi.mocked(runWorkspaceCleanupWorker)

  beforeEach(() => {
    db = mockDbManager()
    scheduler = new WorkspaceCleanupScheduler(db)
    runWorker.mockReset()
    runWorker.mockImplementation(async (job) => {
      if (job.kind === 'orphans') return { kind: 'orphans', cleaned: 0, errors: [] }
      if (job.kind === 'node-modules') return { kind: 'node-modules', pruned: 0, nextCachesPruned: 0, errors: [] }
      if (job.kind === 'finished-workspaces') return { kind: 'finished-workspaces', workspaces: 0, errors: [] }
      return { kind: 'turbo', files: 0, bytes: 0, errors: [] }
    })
  })

  afterEach(() => scheduler.stop())

  it('does not classify all directories as orphans when task lookup is empty', async () => {
    await scheduler.runNow()
    expect(runWorker.mock.calls.some(([job]) => job.kind === 'orphans')).toBe(false)
  })

  it.each([
    TaskStatus.ReadyForReview,
    TaskStatus.Completed,
    TaskStatus.AgentWorking,
    TaskStatus.NotStarted
  ])('passes a %s task ID to the worker so its workspace stays protected', async (status) => {
    vi.mocked(db.getTasks).mockReturnValue([makeTask({ status })])
    await scheduler.runNow()
    expect(runWorker).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'orphans', taskIds: ['task-1'], workspacesRoot: '/test/workspaces'
    }), expect.any(Function))
  })

  it('returns all worker results and runs each cleanup phase', async () => {
    vi.mocked(db.getTasks).mockReturnValue([makeTask()])
    runWorker.mockImplementation(async (job) => {
      if (job.kind === 'orphans') return { kind: 'orphans', cleaned: 2, errors: [] }
      if (job.kind === 'node-modules') return { kind: 'node-modules', pruned: 3, nextCachesPruned: 2, errors: [] }
      if (job.kind === 'finished-workspaces') return { kind: 'finished-workspaces', workspaces: 4, errors: [] }
      return { kind: 'turbo', files: 5, bytes: 1024, errors: [] }
    })
    expect(await scheduler.runNow()).toEqual({ cleaned: 2, retiredWorkspaces: 4, nodeModulesCleaned: 3, nextCachesCleaned: 2, turboFilesCleaned: 5, turboBytesCleaned: 1024, errors: [] })
    expect(runWorker.mock.calls.map(([job]) => job.kind)).toEqual(['orphans', 'node-modules', 'finished-workspaces', 'turbo'])
    expect(runWorker).toHaveBeenCalledWith(expect.objectContaining({ kind: 'turbo', reposRoot: '/test/repos', inactiveDays: 7 }), expect.any(Function))
  })

  it('does not start a second cleanup while the worker is running', async () => {
    vi.mocked(db.getTasks).mockReturnValue([makeTask()])
    let finish!: (value: { kind: 'orphans'; cleaned: number; errors: string[] }) => void
    runWorker.mockImplementation((job) => {
      if (job.kind === 'orphans') return new Promise((resolve) => { finish = resolve })
      if (job.kind === 'node-modules') return Promise.resolve({ kind: 'node-modules', pruned: 0, nextCachesPruned: 0, errors: [] })
      if (job.kind === 'finished-workspaces') return Promise.resolve({ kind: 'finished-workspaces', workspaces: 0, errors: [] })
      return Promise.resolve({ kind: 'turbo', files: 0, bytes: 0, errors: [] })
    })
    const first = scheduler.runNow()
    expect(await scheduler.runNow()).toEqual({ cleaned: 0, retiredWorkspaces: 0, nodeModulesCleaned: 0, nextCachesCleaned: 0, turboFilesCleaned: 0, turboBytesCleaned: 0, errors: ['Cleanup is already in progress'] })
    finish({ kind: 'orphans', cleaned: 0, errors: [] })
    await first
  })
})
