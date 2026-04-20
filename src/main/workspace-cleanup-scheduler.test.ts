import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WorkspaceCleanupScheduler } from './workspace-cleanup-scheduler'
import type { DatabaseManager, TaskRecord } from './database'
import type { WorktreeManager } from './worktree-manager'
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

import { existsSync, rmSync } from 'fs'

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

function mockWorktreeManager(overrides: Record<string, unknown> = {}): WorktreeManager {
  return {
    cleanupTaskWorkspace: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as WorktreeManager
}

// ── Tests ──────────────────────────────────────────────

describe('WorkspaceCleanupScheduler', () => {
  let scheduler: WorkspaceCleanupScheduler
  let db: ReturnType<typeof mockDbManager>
  let worktree: ReturnType<typeof mockWorktreeManager>
  const mockedExistsSync = vi.mocked(existsSync)
  const mockedRmSync = vi.mocked(rmSync)

  beforeEach(() => {
    vi.useFakeTimers()
    db = mockDbManager()
    worktree = mockWorktreeManager()
    scheduler = new WorkspaceCleanupScheduler(db, worktree)

    // Reset fs mocks
    mockedExistsSync.mockReturnValue(false)
    mockedRmSync.mockReturnValue(undefined)
  })

  afterEach(() => {
    scheduler.stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('runNow', () => {
    it('returns zero cleaned when no completed tasks exist', async () => {
      (db.getTasks as ReturnType<typeof vi.fn>).mockReturnValue([])

      const result = await scheduler.runNow()

      expect(result.cleaned).toBe(0)
      expect(result.errors).toEqual([])
    })

    it('does not clean tasks that are not completed', async () => {
      const task = makeTask({ status: TaskStatus.NotStarted, updated_at: '2020-01-01T00:00:00.000Z' })
      ;(db.getTasks as ReturnType<typeof vi.fn>).mockReturnValue([task])
      ;(db.getSetting as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'github_org') return 'test-org'
        if (key === 'workspace_autocleanup_days') return '7'
        return undefined
      })

      const result = await scheduler.runNow()

      expect(result.cleaned).toBe(0)
      expect(worktree.cleanupTaskWorkspace).not.toHaveBeenCalled()
    })

    it('does not clean recently completed tasks within retention period', async () => {
      const task = makeTask({
        status: TaskStatus.Completed,
        updated_at: new Date().toISOString()
      })
      ;(db.getTasks as ReturnType<typeof vi.fn>).mockReturnValue([task])
      ;(db.getSetting as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'github_org') return 'test-org'
        if (key === 'workspace_autocleanup_days') return '7'
        return undefined
      })

      const result = await scheduler.runNow()

      expect(result.cleaned).toBe(0)
      expect(worktree.cleanupTaskWorkspace).not.toHaveBeenCalled()
    })

    it('cleans completed tasks past retention period', async () => {
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
      const task = makeTask({
        id: 'task-old',
        status: TaskStatus.Completed,
        updated_at: eightDaysAgo,
        repos: ['org/repo']
      })
      ;(db.getTasks as ReturnType<typeof vi.fn>).mockReturnValue([task])
      ;(db.getSetting as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'github_org') return 'test-org'
        return undefined // no cleanup days set → should use default 7
      })
      mockedExistsSync.mockReturnValue(true)

      const result = await scheduler.runNow()

      expect(result.cleaned).toBe(1)
      expect(worktree.cleanupTaskWorkspace).toHaveBeenCalledWith(
        'task-old',
        [{ fullName: 'org/repo' }],
        'test-org',
        true
      )
    })

    it('respects custom retention days', async () => {
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
      const task = makeTask({
        id: 'task-recent',
        status: TaskStatus.Completed,
        updated_at: fiveDaysAgo,
        repos: ['org/repo']
      })
      ;(db.getTasks as ReturnType<typeof vi.fn>).mockReturnValue([task])
      ;(db.getSetting as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'github_org') return 'test-org'
        if (key === 'workspace_autocleanup_days') return '3' // 3 day retention
        return undefined
      })
      mockedExistsSync.mockReturnValue(true)

      const result = await scheduler.runNow()

      // 5 days > 3 days retention → should be cleaned
      expect(result.cleaned).toBe(1)
      expect(worktree.cleanupTaskWorkspace).toHaveBeenCalled()
    })

    it('handles cleanup errors gracefully', async () => {
      const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      const task = makeTask({
        id: 'task-error',
        status: TaskStatus.Completed,
        updated_at: oldDate,
        repos: ['org/repo']
      })
      ;(db.getTasks as ReturnType<typeof vi.fn>).mockReturnValue([task])
      ;(db.getSetting as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'github_org') return 'test-org'
        if (key === 'workspace_autocleanup_days') return '7'
        return undefined
      })
      mockedExistsSync.mockReturnValue(true)

      ;(worktree.cleanupTaskWorkspace as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Permission denied')
      )

      const result = await scheduler.runNow()

      expect(result.cleaned).toBe(0)
      expect(result.errors.length).toBe(1)
      expect(result.errors[0]).toContain('Permission denied')
    })

    it('cleans tasks with no repos by removing directory directly', async () => {
      const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      const task = makeTask({
        id: 'task-no-repo',
        status: TaskStatus.Completed,
        updated_at: oldDate,
        repos: [] // no repos
      })
      ;(db.getTasks as ReturnType<typeof vi.fn>).mockReturnValue([task])
      ;(db.getSetting as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'github_org') return 'test-org'
        if (key === 'workspace_autocleanup_days') return '7'
        return undefined
      })
      mockedExistsSync.mockReturnValue(true)

      const result = await scheduler.runNow()

      expect(result.cleaned).toBe(1)
      // Should not call worktreeManager since there are no repos
      expect(worktree.cleanupTaskWorkspace).not.toHaveBeenCalled()
      // Should directly remove the directory
      expect(mockedRmSync).toHaveBeenCalled()
    })
  })

  describe('stop', () => {
    it('stops without error when not started', () => {
      expect(() => scheduler.stop()).not.toThrow()
    })
  })

  describe('getRetentionDays (via runNow behavior)', () => {
    it('uses default 7 days when invalid setting', async () => {
      const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString()
      const task = makeTask({
        status: TaskStatus.Completed,
        updated_at: sixDaysAgo
      })
      ;(db.getTasks as ReturnType<typeof vi.fn>).mockReturnValue([task])
      ;(db.getSetting as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'workspace_autocleanup_days') return 'invalid'
        return undefined
      })

      // 6 days < 7 days default → should NOT be cleaned
      const result = await scheduler.runNow()
      expect(result.cleaned).toBe(0)
    })
  })
})
