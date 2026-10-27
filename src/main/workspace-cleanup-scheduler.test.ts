import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WorkspaceCleanupScheduler } from './workspace-cleanup-scheduler'
import type { DatabaseManager, TaskRecord } from './database'
import { TaskStatus } from '../shared/constants'
import { runWorkspaceCleanupWorker } from './workspace-cleanup-worker-client'

vi.mock('./workspace-cleanup-worker-client', () => ({ runWorkspaceCleanupWorker: vi.fn() }))
vi.mock('./workspace-paths', () => ({ WORKSPACES_DIR: '/test/workspaces', listWorkspaceDirs: () => [] }))
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
    runWorker.mockImplementation(async (job) => job.kind === 'orphans'
      ? { kind: 'orphans', cleaned: 0, errors: [] }
      : { kind: 'node-modules', pruned: 0, errors: [] })
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

  it('returns the worker result and starts the dependency pass after the orphan pass', async () => {
    vi.mocked(db.getTasks).mockReturnValue([makeTask()])
    runWorker.mockImplementation(async (job) => job.kind === 'orphans'
      ? { kind: 'orphans', cleaned: 2, errors: [] }
      : { kind: 'node-modules', pruned: 3, errors: [] })
    expect(await scheduler.runNow()).toEqual({ cleaned: 2, nodeModulesCleaned: 3, errors: [] })
    expect(runWorker.mock.calls.map(([job]) => job.kind)).toEqual(['orphans', 'node-modules'])
  })

  it('does not start a second cleanup while the worker is running', async () => {
    vi.mocked(db.getTasks).mockReturnValue([makeTask()])
    let finish!: (value: { kind: 'orphans'; cleaned: number; errors: string[] }) => void
    runWorker.mockImplementation((job) => job.kind === 'orphans'
      ? new Promise((resolve) => { finish = resolve })
      : Promise.resolve({ kind: 'node-modules', pruned: 0, errors: [] }))
    const first = scheduler.runNow()
    expect(await scheduler.runNow()).toEqual({ cleaned: 0, nodeModulesCleaned: 0, errors: ['Cleanup is already in progress'] })
    finish({ kind: 'orphans', cleaned: 0, errors: [] })
    await first
  })
})
