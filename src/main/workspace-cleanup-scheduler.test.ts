import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WorkspaceCleanupScheduler } from './workspace-cleanup-scheduler'
import type { DatabaseManager, TaskRecord } from './database'
import { TaskStatus } from '../shared/constants'

// Mock fs module at the top level (ESM-safe)
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readdirSync: vi.fn().mockReturnValue([]),
    statSync: vi.fn().mockReturnValue({ mtime: new Date() }),
    rmSync: vi.fn(),
  }
})

vi.mock('./workspace-process-cleanup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workspace-process-cleanup')>()
  return { ...actual, terminateProcessesInWorkspaces: vi.fn().mockResolvedValue([]) }
})

import { terminateProcessesInWorkspaces } from './workspace-process-cleanup'
import { existsSync, readdirSync, rmSync, statSync } from 'fs'

// ── Helpers ──────────────────────────────────────────────

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    title: 'Test Task',
    description: '',
    type: 'general',
    priority: 'medium',
    status: TaskStatus.Completed,
    assignee: '',
    due_date: null,
    labels: [],
    attachments: [],
    repos: ['org/repo'],
    output_fields: [],
    agent_id: null,
    external_id: null,
    source_id: null,
    source: 'local',
    skill_ids: null,
    session_id: null,
    snoozed_until: null,
    resolution: null,
    feedback_rating: null,
    feedback_comment: null,
    is_recurring: false,
    recurrence_pattern: null,
    recurrence_parent_id: null,
    last_occurrence_at: null,
    next_occurrence_at: null,
    heartbeat_enabled: false,
    heartbeat_interval_minutes: null,
    heartbeat_last_check_at: null,
    heartbeat_next_check_at: null,
    parent_task_id: null,
    sort_order: 0,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  } as TaskRecord
}

function mockDbManager(overrides: Record<string, unknown> = {}): DatabaseManager {
  const settings: Record<string, string> = {}
  return {
    getTasks: vi.fn().mockReturnValue([]),
    getSetting: vi.fn((key: string) => settings[key]),
    setSetting: vi.fn((key: string, value: string) => { settings[key] = value }),
    ...overrides,
  } as unknown as DatabaseManager
}

describe('WorkspaceCleanupScheduler', () => {
  let scheduler: WorkspaceCleanupScheduler
  let db: ReturnType<typeof mockDbManager>
  const mockedExistsSync = vi.mocked(existsSync)
  const mockedRmSync = vi.mocked(rmSync)

  beforeEach(() => {
    vi.useFakeTimers()
    db = mockDbManager()
    scheduler = new WorkspaceCleanupScheduler(db)

    // Reset fs mocks
    mockedExistsSync.mockReturnValue(false)
    mockedRmSync.mockReturnValue(undefined)
  })

  afterEach(() => {
    scheduler.stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not treat every workspace as orphaned when task lookup is empty', async () => {
    mockedExistsSync.mockReturnValue(true)
    vi.mocked(readdirSync).mockReturnValue([{ name: 'saved-task', isDirectory: () => true }] as never)
    vi.mocked(statSync).mockReturnValue({ mtime: new Date('2020-01-01') } as never)
    vi.mocked(db.getSetting).mockImplementation((key: string) =>
      key === 'workspace_nodemodules_gc_enabled' ? 'false' : undefined
    )

    const result = await scheduler.runNow()

    expect(result.cleaned).toBe(0)
    expect(mockedRmSync).not.toHaveBeenCalled()
  })

  it.each([
    TaskStatus.ReadyForReview,
    TaskStatus.Completed,
    TaskStatus.AgentWorking,
    TaskStatus.NotStarted
  ])('preserves a %s task workspace and its artifacts after retention', async (status) => {
    const task = makeTask({ status, updated_at: '2020-01-01T00:00:00.000Z' })
    vi.mocked(db.getTasks).mockReturnValue([task])
    vi.mocked(db.getSetting).mockImplementation((key: string) =>
      key === 'workspace_nodemodules_gc_enabled' ? 'false' : key === 'workspace_autocleanup_days' ? '1' : undefined
    )
    mockedExistsSync.mockReturnValue(true)
    vi.mocked(readdirSync).mockReturnValue([{ name: task.id, isDirectory: () => true }] as never)

    const result = await scheduler.runNow()

    expect(result.cleaned).toBe(0)
    expect(mockedRmSync).not.toHaveBeenCalled()
  })

  it('removes an old orphaned workspace, while preserving the completed task workspace', async () => {
    vi.mocked(db.getTasks).mockReturnValue([makeTask({ id: 'completed-task' })])
    vi.mocked(db.getSetting).mockImplementation((key: string) =>
      key === 'workspace_nodemodules_gc_enabled' ? 'false' : undefined
    )
    mockedExistsSync.mockReturnValue(true)
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'completed-task', isDirectory: () => true },
      { name: 'orphan-task', isDirectory: () => true }
    ] as never)
    vi.mocked(statSync).mockReturnValue({ mtime: new Date('2020-01-01') } as never)

    const result = await scheduler.runNow()

    expect(terminateProcessesInWorkspaces).toHaveBeenCalledWith({
      workspacesRoot: expect.any(String),
      workspaceIds: ['orphan-task']
    })
    expect(result.cleaned).toBe(1)
    expect(mockedRmSync).toHaveBeenCalledTimes(1)
    expect(mockedRmSync.mock.calls[0][0]).toContain('orphan-task')
  })
})
