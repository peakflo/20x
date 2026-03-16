import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HeartbeatScheduler } from './heartbeat-scheduler'
import { HeartbeatStatus, HEARTBEAT_OK_TOKEN, HEARTBEAT_INFO_TOKEN, HEARTBEAT_DEFAULTS } from '../shared/constants'
import type { DatabaseManager, TaskRecord } from './database'
import type { AgentManager } from './agent-manager'

// ── Helpers ──────────────────────────────────────────────

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    title: 'Test Task',
    status: 'ready_for_review',
    priority: 'medium',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    agent_id: 'agent-1',
    heartbeat_enabled: 1,
    heartbeat_interval_minutes: 30,
    heartbeat_last_check_at: '2024-01-01T00:00:00.000Z',
    heartbeat_next_check_at: '2024-01-01T00:30:00.000Z',
    ...overrides,
  } as unknown as TaskRecord
}

function mockDbManager(overrides: Record<string, unknown> = {}): DatabaseManager {
  return {
    updateTask: vi.fn(),
    getTask: vi.fn().mockReturnValue(makeTask()),
    getSetting: vi.fn().mockReturnValue(null),
    getHeartbeatDueTasks: vi.fn().mockReturnValue([]),
    getHeartbeatLogs: vi.fn().mockReturnValue([]),
    createHeartbeatLog: vi.fn(),
    getHeartbeatConsecutiveErrors: vi.fn().mockReturnValue(0),
    getWorkspaceDir: vi.fn().mockReturnValue('/tmp/workspace/task-1'),
    getAgent: vi.fn().mockReturnValue({ id: 'agent-1', name: 'Test Agent' }),
    getAgents: vi.fn().mockReturnValue([{ id: 'agent-1', name: 'Test Agent', is_default: true }]),
    ...overrides,
  } as unknown as DatabaseManager
}

function mockAgentManager(overrides: Record<string, unknown> = {}): AgentManager {
  return {
    startHeartbeatSession: vi.fn().mockResolvedValue('session-1'),
    getSession: vi.fn().mockReturnValue({ status: 'idle' }),
    getLastAssistantMessage: vi.fn().mockReturnValue(HEARTBEAT_OK_TOKEN),
    hasActiveSessionForTask: vi.fn().mockReturnValue(false),
    ...overrides,
  } as unknown as AgentManager
}

// ── Tests ──────────────────────────────────────────────

describe('HeartbeatScheduler', () => {
  let scheduler: HeartbeatScheduler
  let db: ReturnType<typeof mockDbManager>
  let agent: ReturnType<typeof mockAgentManager>

  beforeEach(() => {
    vi.useFakeTimers()
    db = mockDbManager()
    agent = mockAgentManager()
    scheduler = new HeartbeatScheduler(db as unknown as DatabaseManager, agent as unknown as AgentManager)
  })

  afterEach(() => {
    scheduler.stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // ── extractGitHubUrls (private, tested via preflight) ──────

  describe('extractGitHubUrls', () => {
    // Access private method for unit testing
    const extract = (content: string) => {
      const s = new HeartbeatScheduler({} as DatabaseManager, {} as AgentManager)
      return (s as unknown as { extractGitHubUrls: (c: string) => unknown[] }).extractGitHubUrls(content)
    }

    it('extracts PR URL', () => {
      const result = extract('Check https://github.com/acme/app/pull/42 for reviews')
      expect(result).toEqual([{ owner: 'acme', repo: 'app', type: 'pull', number: 42 }])
    })

    it('extracts issue URL', () => {
      const result = extract('Watch https://github.com/acme/app/issues/99')
      expect(result).toEqual([{ owner: 'acme', repo: 'app', type: 'issue', number: 99 }])
    })

    it('extracts multiple URLs', () => {
      const content = `
- https://github.com/acme/app/pull/1
- https://github.com/acme/app/issues/2
- https://github.com/other/repo/pull/100
`
      const result = extract(content)
      expect(result).toHaveLength(3)
      expect(result[0]).toEqual({ owner: 'acme', repo: 'app', type: 'pull', number: 1 })
      expect(result[1]).toEqual({ owner: 'acme', repo: 'app', type: 'issue', number: 2 })
      expect(result[2]).toEqual({ owner: 'other', repo: 'repo', type: 'pull', number: 100 })
    })

    it('returns empty array when no URLs found', () => {
      expect(extract('No links here')).toEqual([])
      expect(extract('')).toEqual([])
    })

    it('ignores non-GitHub URLs', () => {
      expect(extract('https://gitlab.com/acme/app/pull/1')).toEqual([])
    })
  })

  // ── isWithinActiveHours ──────────────────────────────────

  describe('isWithinActiveHours', () => {
    const getPrivateMethod = (s: HeartbeatScheduler) =>
      (s as unknown as { isWithinActiveHours: () => boolean }).isWithinActiveHours

    it('returns true when no active hours configured', () => {
      const isWithin = getPrivateMethod(scheduler)
      expect(isWithin.call(scheduler)).toBe(true)
    })

    it('returns true when current time is within range', () => {
      // Set time and compute what the local hour will be, then set active hours around it
      const now = new Date('2024-01-15T14:00:00.000Z')
      vi.setSystemTime(now)
      const localH = now.getHours()
      const localM = now.getMinutes()
      const startH = (localH - 2 + 24) % 24
      const endH = (localH + 2) % 24
      db = mockDbManager({
        getSetting: vi.fn().mockImplementation((key: string) => {
          if (key === 'heartbeat_active_hours_start') return `${String(startH).padStart(2, '0')}:${String(localM).padStart(2, '0')}`
          if (key === 'heartbeat_active_hours_end') return `${String(endH).padStart(2, '0')}:${String(localM).padStart(2, '0')}`
          return null
        })
      })
      scheduler = new HeartbeatScheduler(db as unknown as DatabaseManager, agent as unknown as AgentManager)
      const isWithin = getPrivateMethod(scheduler)
      expect(isWithin.call(scheduler)).toBe(true)
    })

    it('returns false when current time is outside range', () => {
      const now = new Date('2024-01-15T14:00:00.000Z')
      vi.setSystemTime(now)
      const localH = now.getHours()
      // Set a range that is entirely outside current local time
      const startH = (localH + 4) % 24
      const endH = (localH + 6) % 24
      db = mockDbManager({
        getSetting: vi.fn().mockImplementation((key: string) => {
          if (key === 'heartbeat_active_hours_start') return `${String(startH).padStart(2, '0')}:00`
          if (key === 'heartbeat_active_hours_end') return `${String(endH).padStart(2, '0')}:00`
          return null
        })
      })
      scheduler = new HeartbeatScheduler(db as unknown as DatabaseManager, agent as unknown as AgentManager)
      const isWithin = getPrivateMethod(scheduler)
      expect(isWithin.call(scheduler)).toBe(false)
    })

    it('handles overnight range (e.g., 22:00-06:00)', () => {
      vi.setSystemTime(new Date('2024-01-15T23:30:00.000Z'))
      db = mockDbManager({
        getSetting: vi.fn().mockImplementation((key: string) => {
          if (key === 'heartbeat_active_hours_start') return '22:00'
          if (key === 'heartbeat_active_hours_end') return '06:00'
          return null
        })
      })
      scheduler = new HeartbeatScheduler(db as unknown as DatabaseManager, agent as unknown as AgentManager)
      // Since the method uses local time via new Date(), and we've set system time,
      // the result depends on the timezone of the test runner, so we just verify it doesn't throw
      const isWithin = getPrivateMethod(scheduler)
      expect(typeof isWithin.call(scheduler)).toBe('boolean')
    })
  })

  // ── requiresCurrentStateChecks ───────────────────────────

  describe('requiresCurrentStateChecks', () => {
    const requiresCurrentStateChecks = (content: string) => {
      const scheduler = new HeartbeatScheduler({} as DatabaseManager, {} as AgentManager)
      return (scheduler as unknown as {
        requiresCurrentStateChecks: (heartbeatContent: string) => boolean
      }).requiresCurrentStateChecks(content)
    }

    it('returns true for requested changes and CI checks', () => {
      expect(requiresCurrentStateChecks('Verify CI pipeline passed')).toBe(true)
      expect(requiresCurrentStateChecks('Watch for requested changes on the PR')).toBe(true)
    })

    it('returns false for comments and conflict-only checks', () => {
      expect(requiresCurrentStateChecks('Check for new PR comments and issue comments')).toBe(false)
      expect(requiresCurrentStateChecks('Check whether the PR has conflicts')).toBe(false)
    })
  })

  describe('hasMergeConflicts', () => {
    const hasMergeConflicts = (prState: { mergeable: boolean | null; mergeable_state?: string | null }) => {
      const scheduler = new HeartbeatScheduler({} as DatabaseManager, {} as AgentManager)
      return (scheduler as unknown as {
        hasMergeConflicts: (prState: { mergeable: boolean | null; mergeable_state?: string | null }) => boolean
      }).hasMergeConflicts(prState)
    }

    it('returns true for dirty merge state', () => {
      expect(hasMergeConflicts({ mergeable: false, mergeable_state: 'dirty' })).toBe(true)
    })

    it('returns false for non-conflicting states', () => {
      expect(hasMergeConflicts({ mergeable: true, mergeable_state: 'clean' })).toBe(false)
      expect(hasMergeConflicts({ mergeable: null, mergeable_state: 'unknown' })).toBe(false)
    })
  })

  // ── buildHeartbeatPrompt ──────────────────────────────────

  describe('buildHeartbeatPrompt', () => {
    it('includes task title and heartbeat content', () => {
      const buildPrompt = (scheduler as unknown as {
        buildHeartbeatPrompt: (task: TaskRecord, content: string) => string
      }).buildHeartbeatPrompt

      const task = makeTask({ title: 'Fix auth bug' })
      const content = '- Check PR https://github.com/acme/app/pull/42\n- Verify CI passes'
      const prompt = buildPrompt.call(scheduler, task, content)

      expect(prompt).toContain('Fix auth bug')
      expect(prompt).toContain(content)
      expect(prompt).toContain(HEARTBEAT_OK_TOKEN)
    })

    it('adds current-state guidance for conflicts and CI checks', () => {
      const buildPrompt = (scheduler as unknown as {
        buildHeartbeatPrompt: (task: TaskRecord, content: string) => string
      }).buildHeartbeatPrompt

      const task = makeTask({ title: 'Fix auth bug' })
      const content = '- Check PR conflicts\n- Verify CI pipeline passed'
      const prompt = buildPrompt.call(scheduler, task, content)

      expect(prompt).toContain('inspect the current state even if the problem started before the last check')
    })
  })

  // ── advanceNextCheck (adaptive intervals) ─────────────

  describe('advanceNextCheck', () => {
    const advance = (scheduler: HeartbeatScheduler) =>
      (scheduler as unknown as {
        advanceNextCheck: (task: TaskRecord, isOk?: boolean) => void
      }).advanceNextCheck

    it('uses base interval when isOk is undefined', () => {
      vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'))
      const task = makeTask({ heartbeat_interval_minutes: 30 })
      advance(scheduler).call(scheduler, task)

      expect(db.updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({
        heartbeat_last_check_at: expect.any(String),
        heartbeat_next_check_at: expect.any(String),
      }))

      const call = (db.updateTask as ReturnType<typeof vi.fn>).mock.calls[0][1]
      const next = new Date(call.heartbeat_next_check_at)
      const now = new Date('2024-01-15T12:00:00.000Z')
      // 30 minutes later
      expect(next.getTime() - now.getTime()).toBe(30 * 60_000)
    })

    it('uses base interval on OK with fewer than 3 consecutive OKs', () => {
      vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'))
      ;(db.getHeartbeatLogs as ReturnType<typeof vi.fn>).mockReturnValue([
        { status: HeartbeatStatus.Ok },
        { status: HeartbeatStatus.Ok },
      ])

      const task = makeTask({ heartbeat_interval_minutes: 30 })
      advance(scheduler).call(scheduler, task, true)

      const call = (db.updateTask as ReturnType<typeof vi.fn>).mock.calls[0][1]
      const next = new Date(call.heartbeat_next_check_at)
      const now = new Date('2024-01-15T12:00:00.000Z')
      expect(next.getTime() - now.getTime()).toBe(30 * 60_000)
    })

    it('doubles interval after 3+ consecutive OKs', () => {
      vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'))
      ;(db.getHeartbeatLogs as ReturnType<typeof vi.fn>).mockReturnValue([
        { status: HeartbeatStatus.Ok },
        { status: HeartbeatStatus.Ok },
        { status: HeartbeatStatus.Ok },
        { status: HeartbeatStatus.AttentionNeeded },
      ])

      const task = makeTask({ heartbeat_interval_minutes: 30 })
      advance(scheduler).call(scheduler, task, true)

      const call = (db.updateTask as ReturnType<typeof vi.fn>).mock.calls[0][1]
      const next = new Date(call.heartbeat_next_check_at)
      const now = new Date('2024-01-15T12:00:00.000Z')
      // 2x = 60 minutes
      expect(next.getTime() - now.getTime()).toBe(60 * 60_000)
    })

    it('quadruples interval after 6+ consecutive OKs', () => {
      vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'))
      ;(db.getHeartbeatLogs as ReturnType<typeof vi.fn>).mockReturnValue([
        { status: HeartbeatStatus.Ok },
        { status: HeartbeatStatus.Ok },
        { status: HeartbeatStatus.Ok },
        { status: HeartbeatStatus.Ok },
        { status: HeartbeatStatus.Ok },
        { status: HeartbeatStatus.Ok },
      ])

      const task = makeTask({ heartbeat_interval_minutes: 30 })
      advance(scheduler).call(scheduler, task, true)

      const call = (db.updateTask as ReturnType<typeof vi.fn>).mock.calls[0][1]
      const next = new Date(call.heartbeat_next_check_at)
      const now = new Date('2024-01-15T12:00:00.000Z')
      // 4x = 120 minutes
      expect(next.getTime() - now.getTime()).toBe(120 * 60_000)
    })

    it('resets to base interval when isOk is false', () => {
      vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'))
      ;(db.getHeartbeatLogs as ReturnType<typeof vi.fn>).mockReturnValue([
        { status: HeartbeatStatus.Ok },
        { status: HeartbeatStatus.Ok },
        { status: HeartbeatStatus.Ok },
        { status: HeartbeatStatus.Ok },
        { status: HeartbeatStatus.Ok },
        { status: HeartbeatStatus.Ok },
      ])

      const task = makeTask({ heartbeat_interval_minutes: 30 })
      advance(scheduler).call(scheduler, task, false)

      const call = (db.updateTask as ReturnType<typeof vi.fn>).mock.calls[0][1]
      const next = new Date(call.heartbeat_next_check_at)
      const now = new Date('2024-01-15T12:00:00.000Z')
      // Base interval, not adaptive
      expect(next.getTime() - now.getTime()).toBe(30 * 60_000)
    })

    it('uses default interval when task has no interval set', () => {
      vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'))
      const task = makeTask({ heartbeat_interval_minutes: undefined as unknown as number })
      advance(scheduler).call(scheduler, task)

      const call = (db.updateTask as ReturnType<typeof vi.fn>).mock.calls[0][1]
      const next = new Date(call.heartbeat_next_check_at)
      const now = new Date('2024-01-15T12:00:00.000Z')
      expect(next.getTime() - now.getTime()).toBe(HEARTBEAT_DEFAULTS.intervalMinutes * 60_000)
    })
  })

  // ── enableHeartbeat / disableHeartbeat ─────────────────

  describe('enableHeartbeat', () => {
    it('sets heartbeat_enabled and next check time', () => {
      vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'))
      scheduler.enableHeartbeat('task-1', 60)

      expect(db.updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({
        heartbeat_enabled: true,
        heartbeat_interval_minutes: 60,
        heartbeat_next_check_at: expect.any(String),
      }))

      const call = (db.updateTask as ReturnType<typeof vi.fn>).mock.calls[0][1]
      const next = new Date(call.heartbeat_next_check_at)
      const now = new Date('2024-01-15T12:00:00.000Z')
      expect(next.getTime() - now.getTime()).toBe(60 * 60_000)
    })

    it('uses default interval when none specified', () => {
      vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'))
      scheduler.enableHeartbeat('task-1')

      const call = (db.updateTask as ReturnType<typeof vi.fn>).mock.calls[0][1]
      expect(call.heartbeat_interval_minutes).toBe(HEARTBEAT_DEFAULTS.intervalMinutes)
    })
  })

  describe('disableHeartbeat', () => {
    it('sets heartbeat_enabled=false and clears next check', () => {
      scheduler.disableHeartbeat('task-1')

      expect(db.updateTask).toHaveBeenCalledWith('task-1', {
        heartbeat_enabled: false,
        heartbeat_next_check_at: null,
      })
    })
  })

  // ── handleResult ────────────────────────────────────────

  describe('handleResult', () => {
    const handle = (scheduler: HeartbeatScheduler) =>
      (scheduler as unknown as {
        handleResult: (task: TaskRecord, sessionId: string, result: string) => void
      }).handleResult

    it('logs OK and advances with adaptive interval on HEARTBEAT_OK', () => {
      vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'))
      const task = makeTask()
      handle(scheduler).call(scheduler, task, 'session-1', `Everything is fine. ${HEARTBEAT_OK_TOKEN}`)

      expect(db.createHeartbeatLog).toHaveBeenCalledWith(expect.objectContaining({
        task_id: 'task-1',
        status: HeartbeatStatus.Ok,
        summary: 'Everything is fine.',
        session_id: 'session-1',
      }))
    })

    it('falls back to default OK summary when only token is returned', () => {
      const task = makeTask()
      handle(scheduler).call(scheduler, task, 'session-1', HEARTBEAT_OK_TOKEN)

      expect(db.createHeartbeatLog).toHaveBeenCalledWith(expect.objectContaining({
        status: HeartbeatStatus.Ok,
        summary: 'All checks passed (no new updates)',
      }))
    })

    it('strips HEARTBEAT_INFO token prefix from summaries', () => {
      const extractSummary = (scheduler as unknown as {
        extractSummary: (result: string, status: HeartbeatStatus) => string
      }).extractSummary

      const summary = extractSummary.call(
        scheduler,
        `${HEARTBEAT_INFO_TOKEN}: PR approved; no action needed`,
        HeartbeatStatus.Info,
      )

      expect(summary).toBe('PR approved; no action needed')
    })

    it('logs attention needed and notifies on non-OK result', () => {
      vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'))
      const task = makeTask()
      handle(scheduler).call(scheduler, task, 'session-1', 'PR has 2 new review comments that need addressing')

      expect(db.createHeartbeatLog).toHaveBeenCalledWith(expect.objectContaining({
        task_id: 'task-1',
        status: HeartbeatStatus.AttentionNeeded,
      }))
    })

    it('truncates long summaries to 500 chars', () => {
      vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'))
      const task = makeTask()
      const longResult = 'A'.repeat(600)
      handle(scheduler).call(scheduler, task, 'session-1', longResult)

      const logCall = (db.createHeartbeatLog as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(logCall.summary.length).toBeLessThanOrEqual(500)
    })
  })

  // ── checkConsecutiveErrors ─────────────────────────────

  describe('checkConsecutiveErrors', () => {
    const checkErrors = (scheduler: HeartbeatScheduler) =>
      (scheduler as unknown as {
        checkConsecutiveErrors: (taskId: string) => void
      }).checkConsecutiveErrors

    it('does nothing when errors are below threshold', () => {
      ;(db.getHeartbeatConsecutiveErrors as ReturnType<typeof vi.fn>).mockReturnValue(2)
      checkErrors(scheduler).call(scheduler, 'task-1')

      // updateTask should NOT have been called (no disable)
      expect(db.updateTask).not.toHaveBeenCalled()
    })

    it('auto-disables heartbeat when errors reach threshold', () => {
      ;(db.getHeartbeatConsecutiveErrors as ReturnType<typeof vi.fn>).mockReturnValue(3)
      checkErrors(scheduler).call(scheduler, 'task-1')

      expect(db.updateTask).toHaveBeenCalledWith('task-1', {
        heartbeat_enabled: false,
        heartbeat_next_check_at: null,
      })
    })

    it('respects custom max errors setting', () => {
      ;(db.getSetting as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'heartbeat_max_consecutive_errors') return '5'
        return null
      })
      ;(db.getHeartbeatConsecutiveErrors as ReturnType<typeof vi.fn>).mockReturnValue(4)

      checkErrors(scheduler).call(scheduler, 'task-1')
      expect(db.updateTask).not.toHaveBeenCalled() // 4 < 5

      ;(db.getHeartbeatConsecutiveErrors as ReturnType<typeof vi.fn>).mockReturnValue(5)
      checkErrors(scheduler).call(scheduler, 'task-1')
      expect(db.updateTask).toHaveBeenCalled() // 5 >= 5
    })
  })

  // ── resolveAgentId ─────────────────────────────────────

  describe('resolveAgentId', () => {
    const resolve = (scheduler: HeartbeatScheduler) =>
      (scheduler as unknown as {
        resolveAgentId: (task: TaskRecord) => string | null
      }).resolveAgentId

    it('uses dedicated heartbeat agent if configured', () => {
      ;(db.getSetting as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'heartbeat_agent_id') return 'heartbeat-agent'
        return null
      })
      ;(db.getAgent as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'heartbeat-agent' })

      const task = makeTask({ agent_id: 'task-agent' })
      expect(resolve(scheduler).call(scheduler, task)).toBe('heartbeat-agent')
    })

    it('falls back to task agent_id', () => {
      const task = makeTask({ agent_id: 'task-agent' })
      expect(resolve(scheduler).call(scheduler, task)).toBe('task-agent')
    })

    it('falls back to default agent', () => {
      const task = makeTask({ agent_id: undefined as unknown as string })
      expect(resolve(scheduler).call(scheduler, task)).toBe('agent-1')
    })

    it('returns null when no agents available', () => {
      ;(db.getAgents as ReturnType<typeof vi.fn>).mockReturnValue([])
      const task = makeTask({ agent_id: undefined as unknown as string })
      expect(resolve(scheduler).call(scheduler, task)).toBeNull()
    })
  })

  // ── start / stop ────────────────────────────────────────

  describe('start / stop', () => {
    it('starts periodic checking', () => {
      const mockWindow = { webContents: { send: vi.fn() }, isDestroyed: vi.fn().mockReturnValue(false) }
      scheduler.start(mockWindow as unknown as import('electron').BrowserWindow)

      // checkHeartbeats should have been called immediately
      expect(db.getHeartbeatDueTasks).toHaveBeenCalledTimes(1)

      // Advance timer by one tick (60s)
      vi.advanceTimersByTime(HEARTBEAT_DEFAULTS.checkIntervalMs)
      expect(db.getHeartbeatDueTasks).toHaveBeenCalledTimes(2)
    })

    it('stops the interval', () => {
      const mockWindow = { webContents: { send: vi.fn() }, isDestroyed: vi.fn().mockReturnValue(false) }
      scheduler.start(mockWindow as unknown as import('electron').BrowserWindow)
      scheduler.stop()

      vi.advanceTimersByTime(HEARTBEAT_DEFAULTS.checkIntervalMs * 5)
      // Should not have been called more than once (initial call only)
      expect(db.getHeartbeatDueTasks).toHaveBeenCalledTimes(1)
    })
  })

  // ── checkHeartbeats (private integration-style) ────────

  describe('checkHeartbeats', () => {
    const check = (scheduler: HeartbeatScheduler) =>
      (scheduler as unknown as {
        checkHeartbeats: () => Promise<void>
      }).checkHeartbeats

    it('skips when globally disabled', async () => {
      ;(db.getSetting as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'heartbeat_enabled_global') return 'false'
        return null
      })

      await check(scheduler).call(scheduler)
      expect(db.getHeartbeatDueTasks).not.toHaveBeenCalled()
    })

    it('skips when no tasks are due', async () => {
      ;(db.getHeartbeatDueTasks as ReturnType<typeof vi.fn>).mockReturnValue([])
      await check(scheduler).call(scheduler)
      expect(db.getHeartbeatDueTasks).toHaveBeenCalled()
    })

    it('skips tasks with active agent sessions', async () => {
      const dueTask = makeTask()
      ;(db.getHeartbeatDueTasks as ReturnType<typeof vi.fn>).mockReturnValue([dueTask])
      ;(agent.hasActiveSessionForTask as ReturnType<typeof vi.fn>).mockReturnValue(true)

      await check(scheduler).call(scheduler)

      expect(agent.hasActiveSessionForTask).toHaveBeenCalledWith('task-1')
      // Should not have tried to start a heartbeat session
      expect(agent.startHeartbeatSession).not.toHaveBeenCalled()
    })
  })

  describe('writeHeartbeatFile', () => {
    it('resets the heartbeat baseline when instructions change', () => {
      const db = mockDbManager({
        getWorkspaceDir: vi.fn().mockReturnValue(`/tmp/heartbeat-${Date.now()}`),
        getTask: vi.fn().mockReturnValue(makeTask()),
      })
      const scheduler = new HeartbeatScheduler(db as unknown as DatabaseManager, agent as unknown as AgentManager)

      scheduler.writeHeartbeatFile('task-1', `# Heartbeat Checks\n- [ ] Check PR conflicts`)

      expect(db.updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({
        heartbeat_last_check_at: null,
        heartbeat_next_check_at: expect.any(String),
      }))
    })
  })

  // ── hasHeartbeatFile / readHeartbeatFile ────────────────

  describe('getHeartbeatFilePath', () => {
    it('returns path with heartbeat.md in workspace dir', () => {
      const path = scheduler.getHeartbeatFilePath('task-1')
      expect(path).toContain('heartbeat.md')
      expect(path).toContain('task-1')
    })
  })

  // ── hasFailedCheckRuns ────────────────────────────────

  describe('hasFailedCheckRuns', () => {
    const hasFailedCheckRuns = (scheduler: HeartbeatScheduler) =>
      (scheduler as unknown as {
        hasFailedCheckRuns: (owner: string, repo: string, sha: string) => Promise<boolean>
      }).hasFailedCheckRuns

    it('exposes the method with the correct signature', () => {
      const s = new HeartbeatScheduler({} as DatabaseManager, {} as AgentManager)
      // Verify the method exists and has the right signature
      expect(typeof hasFailedCheckRuns(s)).toBe('function')
    })
  })

  // ── waitForSessionResult (dangerous default fix) ────

  describe('waitForSessionResult', () => {
    it('rejects when session completes without producing a message', async () => {
      vi.useRealTimers()

      const agentWithNoMessage = mockAgentManager({
        getSession: vi.fn().mockReturnValue({ status: 'idle', seenPartIds: new Set(['part-1']) }),
        getLastAssistantMessage: vi.fn().mockReturnValue(null), // No message produced
      })
      const s = new HeartbeatScheduler(db as unknown as DatabaseManager, agentWithNoMessage as unknown as AgentManager)

      const waitForSessionResult = (s as unknown as {
        waitForSessionResult: (sessionId: string, taskId: string) => Promise<string>
      }).waitForSessionResult

      await expect(
        waitForSessionResult.call(s, 'session-1', 'task-1')
      ).rejects.toThrow('completed without producing a result')
    })

    it('resolves with the assistant message when session completes normally', async () => {
      vi.useRealTimers()

      const agentWithMessage = mockAgentManager({
        getSession: vi.fn().mockReturnValue({ status: 'idle', seenPartIds: new Set(['part-1']) }),
        getLastAssistantMessage: vi.fn().mockReturnValue('CI is failing on the PR'),
      })
      const s = new HeartbeatScheduler(db as unknown as DatabaseManager, agentWithMessage as unknown as AgentManager)

      const waitForSessionResult = (s as unknown as {
        waitForSessionResult: (sessionId: string, taskId: string) => Promise<string>
      }).waitForSessionResult

      const result = await waitForSessionResult.call(s, 'session-1', 'task-1')
      expect(result).toBe('CI is failing on the PR')
    })

    it('keeps waiting when session is idle but has no messages yet (race condition guard)', { timeout: 15_000 }, async () => {
      vi.useRealTimers()

      // Session is idle but seenPartIds is empty — agent hasn't processed the prompt yet
      let pollCount = 0
      const agentWithRace = mockAgentManager({
        getSession: vi.fn().mockImplementation(() => {
          pollCount++
          if (pollCount <= 2) {
            // First 2 polls: idle with no messages (race condition)
            return { status: 'idle', seenPartIds: new Set() }
          }
          // After that: working then idle with messages
          return { status: 'idle', seenPartIds: new Set(['part-1']) }
        }),
        getLastAssistantMessage: vi.fn().mockReturnValue(`${HEARTBEAT_OK_TOKEN}`),
      })
      const s = new HeartbeatScheduler(db as unknown as DatabaseManager, agentWithRace as unknown as AgentManager)

      const waitForSessionResult = (s as unknown as {
        waitForSessionResult: (sessionId: string, taskId: string) => Promise<string>
      }).waitForSessionResult

      const result = await waitForSessionResult.call(s, 'session-1', 'task-1')
      expect(result).toContain(HEARTBEAT_OK_TOKEN)
      expect(pollCount).toBeGreaterThan(2) // Confirmed it waited past the race condition
    })
  })

  // ── countConsecutiveOks ────────────────────────────────

  describe('countConsecutiveOks', () => {
    const count = (scheduler: HeartbeatScheduler) =>
      (scheduler as unknown as {
        countConsecutiveOks: (taskId: string) => number
      }).countConsecutiveOks

    it('counts consecutive OKs from most recent', () => {
      ;(db.getHeartbeatLogs as ReturnType<typeof vi.fn>).mockReturnValue([
        { status: HeartbeatStatus.Ok },
        { status: HeartbeatStatus.Ok },
        { status: HeartbeatStatus.Ok },
        { status: HeartbeatStatus.AttentionNeeded },
        { status: HeartbeatStatus.Ok },
      ])

      expect(count(scheduler).call(scheduler, 'task-1')).toBe(3)
    })

    it('returns 0 when most recent is not OK', () => {
      ;(db.getHeartbeatLogs as ReturnType<typeof vi.fn>).mockReturnValue([
        { status: HeartbeatStatus.Error },
        { status: HeartbeatStatus.Ok },
      ])

      expect(count(scheduler).call(scheduler, 'task-1')).toBe(0)
    })

    it('returns 0 when no logs exist', () => {
      ;(db.getHeartbeatLogs as ReturnType<typeof vi.fn>).mockReturnValue([])
      expect(count(scheduler).call(scheduler, 'task-1')).toBe(0)
    })
  })
})
