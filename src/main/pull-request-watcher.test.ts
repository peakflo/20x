import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PullRequestWatcher, resolvePullRequestWatchEnabled, type PullRequestWatchAgents, type PullRequestWatchSource } from './pull-request-watcher'
import type { DatabaseManager, PullRequestWatchRecord } from './database'
import type { PullRequestWatchSnapshot } from './pull-request-watch'
import {
  PR_WATCH_ENABLED_SETTING,
  PR_WATCH_IDLE_AFTER_MS,
  PR_WATCH_IDLE_INTERVAL_MS,
  PR_WATCH_INTERVAL_MS,
  PR_WATCH_READY_SETTING
} from './pull-request-watch'

/** A fake clock the watcher reads through its `now` option. */
function createClock(start = Date.parse('2026-10-05T10:00:00.000Z')) {
  let current = start
  return {
    now: () => new Date(current),
    advance: (ms: number) => { current += ms }
  }
}

const URL_PR = 'https://github.com/acme/app/pull/42'

interface FakeTask {
  id: string
  status: string
  agent_id: string | null
  pr_watch_enabled: boolean | null
}

/** In-memory stand-in for the pr_watches methods the watcher uses. */
function createFakeDb() {
  const tasks = new Map<string, FakeTask>()
  const watches = new Map<string, PullRequestWatchRecord>()
  const settings = new Map<string, string>()
  const key = (taskId: string, url: string) => `${taskId}|${url}`
  const now = '2026-10-05T10:00:00.000Z'

  const db = {
    getTask: vi.fn((id: string) => tasks.get(id)),
    getSetting: vi.fn((k: string) => settings.get(k)),
    addPullRequestWatch: vi.fn((taskId: string, url: string) => {
      if (watches.has(key(taskId, url))) return false
      watches.set(key(taskId, url), {
        task_id: taskId, url, state: 'active', seen_keys: [], pending_events: [],
        stopped_reason: null, last_checked_at: null, created_at: now, updated_at: now
      })
      return true
    }),
    getPullRequestWatch: vi.fn((taskId: string, url: string) => watches.get(key(taskId, url))),
    reactivatePullRequestWatch: vi.fn((taskId: string, url: string) => {
      const watch = watches.get(key(taskId, url))
      if (watch) watches.set(key(taskId, url), { ...watch, state: 'active', stopped_reason: null })
    }),
    listActivePullRequestWatches: vi.fn(() => [...watches.values()].filter((w) => w.state === 'active')),
    savePullRequestWatchProgress: vi.fn((taskId: string, url: string, progress: { seenKeys: string[]; pendingEvents: PullRequestWatchRecord['pending_events']; checkedAt: string }) => {
      const watch = watches.get(key(taskId, url))
      if (watch) watches.set(key(taskId, url), { ...watch, seen_keys: progress.seenKeys, pending_events: progress.pendingEvents, last_checked_at: progress.checkedAt })
    }),
    stopPullRequestWatch: vi.fn((taskId: string, url: string, reason: string) => {
      const watch = watches.get(key(taskId, url))
      if (watch) watches.set(key(taskId, url), { ...watch, state: 'stopped', stopped_reason: reason, pending_events: [] })
    })
  }

  return { db, tasks, watches, settings }
}

function openSnapshot(overrides: Partial<PullRequestWatchSnapshot> = {}): PullRequestWatchSnapshot {
  return {
    url: URL_PR,
    state: 'OPEN',
    isDraft: false,
    headSha: 'abcdef1234567',
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    checks: [{ name: 'build', completed: true, conclusion: 'FAILURE', runId: 'run-1', url: 'https://ci/1' }],
    comments: [],
    ...overrides
  }
}

describe('resolvePullRequestWatchEnabled', () => {
  it('lets a task switch override the global setting, and follows the global one when unset', () => {
    expect(resolvePullRequestWatchEnabled(null, true)).toBe(true)
    expect(resolvePullRequestWatchEnabled(null, false)).toBe(false)
    expect(resolvePullRequestWatchEnabled(true, false)).toBe(true)
    expect(resolvePullRequestWatchEnabled(false, true)).toBe(false)
  })
})

describe('PullRequestWatcher', () => {
  let fake: ReturnType<typeof createFakeDb>
  let fetchSnapshot: ReturnType<typeof vi.fn<(url: string) => Promise<PullRequestWatchSnapshot>>>
  let agentStatus: string | null
  let sendByTaskId: ReturnType<typeof vi.fn<(taskId: string, message: string) => Promise<unknown>>>
  let watcher: PullRequestWatcher
  let clock: ReturnType<typeof createClock>
  const agents = (): PullRequestWatchAgents => ({
    findSessionByTaskId: (taskId: string) => (agentStatus === null ? undefined : { sessionId: `s-${taskId}`, session: { status: agentStatus } }),
    sendByTaskId
  })
  const source = (): PullRequestWatchSource => ({ fetchPullRequestWatchSnapshot: fetchSnapshot })

  beforeEach(() => {
    fake = createFakeDb()
    fake.tasks.set('task-1', { id: 'task-1', status: 'agent_working', agent_id: 'agent-1', pr_watch_enabled: null })
    fetchSnapshot = vi.fn<(url: string) => Promise<PullRequestWatchSnapshot>>(async () => openSnapshot())
    agentStatus = 'idle'
    sendByTaskId = vi.fn(async () => ({ sessionId: 's-task-1' }))
    clock = createClock()
    watcher = new PullRequestWatcher(fake.db as unknown as DatabaseManager, agents(), source(), {
      now: clock.now
    })
  })

  describe('register', () => {
    it('rejects URLs that are not GitHub pull requests', () => {
      expect(watcher.register('task-1', 'https://example.com/x', { explicit: true })).toEqual({
        ok: false,
        error: 'Only GitHub pull request URLs can be watched.'
      })
    })

    it('rejects unknown tasks', () => {
      expect(watcher.register('missing', URL_PR, { explicit: true })).toEqual({ ok: false, error: 'Task not found' })
    })

    it('creates a watch once and reports whether the task allows watching', () => {
      const first = watcher.register('task-1', URL_PR, { explicit: false })
      expect(first).toEqual({ ok: true, url: URL_PR, created: true, enabled: true })
      const second = watcher.register('task-1', URL_PR, { explicit: false })
      expect(second).toMatchObject({ ok: true, created: false })
    })

    it('reports enabled=false when the task has switched watching off', () => {
      fake.tasks.get('task-1')!.pr_watch_enabled = false
      expect(watcher.register('task-1', URL_PR, { explicit: true })).toMatchObject({ ok: true, enabled: false })
    })

    it('does not revive a stopped watch from automatic detection, but does for an explicit request', async () => {
      watcher.register('task-1', URL_PR, { explicit: false })
      fetchSnapshot.mockResolvedValueOnce(openSnapshot({ state: 'MERGED' }))
      await watcher.tick()
      expect(fake.watches.get('task-1|' + URL_PR)?.state).toBe('stopped')

      watcher.register('task-1', URL_PR, { explicit: false })
      expect(fake.watches.get('task-1|' + URL_PR)?.state).toBe('stopped')

      watcher.register('task-1', URL_PR, { explicit: true })
      expect(fake.watches.get('task-1|' + URL_PR)?.state).toBe('active')
    })
  })

  describe('tick', () => {
    it('wakes an idle agent once with the failing check, then stays quiet for the same commit', async () => {
      watcher.register('task-1', URL_PR, { explicit: false })
      await watcher.tick()
      expect(sendByTaskId).toHaveBeenCalledTimes(1)
      const [taskId, message] = sendByTaskId.mock.calls[0]
      expect(taskId).toBe('task-1')
      expect(message).toContain('CI check "build" failed')

      await watcher.tick()
      expect(sendByTaskId).toHaveBeenCalledTimes(1)
    })

    it('queues events while the agent is busy and delivers them together once it is idle', async () => {
      watcher.register('task-1', URL_PR, { explicit: false })
      agentStatus = 'working'
      await watcher.tick()
      expect(sendByTaskId).not.toHaveBeenCalled()
      expect(fake.watches.get('task-1|' + URL_PR)?.pending_events).toHaveLength(1)

      agentStatus = 'idle'
      clock.advance(PR_WATCH_INTERVAL_MS)
      fetchSnapshot.mockResolvedValueOnce(openSnapshot({
        comments: [{ kind: 'review_comment', id: '7', author: 'alice', authorAssociation: 'MEMBER', isBot: false, body: 'Please rename', path: 'a.ts', line: 1 }]
      }))
      await watcher.tick()
      expect(sendByTaskId).toHaveBeenCalledTimes(1)
      const message = sendByTaskId.mock.calls[0][1]
      expect(message).toContain('CI check "build" failed')
      expect(message).toContain('New review comment from @alice on a.ts:1')
      expect(fake.watches.get('task-1|' + URL_PR)?.pending_events).toEqual([])
    })

    it('keeps the queue when delivery fails, so the next poll retries', async () => {
      watcher.register('task-1', URL_PR, { explicit: false })
      sendByTaskId.mockRejectedValueOnce(new Error('session gone'))
      await watcher.tick()
      expect(fake.watches.get('task-1|' + URL_PR)?.pending_events).toHaveLength(1)

      clock.advance(PR_WATCH_INTERVAL_MS)
      await watcher.tick()
      expect(sendByTaskId).toHaveBeenCalledTimes(2)
      expect(fake.watches.get('task-1|' + URL_PR)?.pending_events).toEqual([])
    })

    it('queues when the task has no agent', async () => {
      fake.tasks.get('task-1')!.agent_id = null
      agentStatus = null
      watcher.register('task-1', URL_PR, { explicit: false })
      await watcher.tick()
      expect(sendByTaskId).not.toHaveBeenCalled()
      expect(fake.watches.get('task-1|' + URL_PR)?.pending_events).toHaveLength(1)
    })

    it('stops watching when the PR is merged or closed, and drops queued events', async () => {
      watcher.register('task-1', URL_PR, { explicit: false })
      agentStatus = 'working'
      await watcher.tick()
      clock.advance(PR_WATCH_INTERVAL_MS)
      fetchSnapshot.mockResolvedValueOnce(openSnapshot({ state: 'MERGED' }))
      await watcher.tick()
      const watch = fake.watches.get('task-1|' + URL_PR)!
      expect(watch.state).toBe('stopped')
      expect(watch.stopped_reason).toBe('merged')
      expect(watch.pending_events).toEqual([])
      expect(sendByTaskId).not.toHaveBeenCalled()
    })

    it('pauses a completed task without polling GitHub, and resumes when it is reopened', async () => {
      watcher.register('task-1', URL_PR, { explicit: false })
      fake.tasks.get('task-1')!.status = 'completed'
      await watcher.tick()
      expect(fetchSnapshot).not.toHaveBeenCalled()
      expect(fake.watches.get('task-1|' + URL_PR)?.state).toBe('active')

      fake.tasks.get('task-1')!.status = 'agent_working'
      // The pause sets a poll interval, so force the next due poll through the fake clock.
      clock.advance(PR_WATCH_INTERVAL_MS + 1)
      await watcher.tick()
      expect(fetchSnapshot).toHaveBeenCalledTimes(1)
      expect(sendByTaskId).toHaveBeenCalledTimes(1)
    })

    it('saves the cursor before sending, so a crash after the send cannot lose the record', async () => {
      watcher.register('task-1', URL_PR, { explicit: false })
      let cursorAtSend: string[] | undefined
      sendByTaskId.mockImplementationOnce(async () => {
        cursorAtSend = fake.watches.get('task-1|' + URL_PR)?.seen_keys
        return {}
      })
      await watcher.tick()
      expect(cursorAtSend).toEqual(['check:abcdef1234567:build:run-1:FAILURE'])
    })

    it('backs off after a rate-limited read and does not poll again until it expires', async () => {
      watcher.register('task-1', URL_PR, { explicit: false })
      fetchSnapshot.mockRejectedValueOnce(new Error('HTTP 403: API rate limit exceeded'))
      await watcher.tick()
      expect(fetchSnapshot).toHaveBeenCalledTimes(1)

      // First failure: retry after one interval.
      clock.advance(PR_WATCH_INTERVAL_MS - 1000)
      await watcher.tick()
      expect(fetchSnapshot).toHaveBeenCalledTimes(1)

      clock.advance(1000)
      fetchSnapshot.mockRejectedValueOnce(new Error('HTTP 429 Too Many Requests'))
      await watcher.tick()
      expect(fetchSnapshot).toHaveBeenCalledTimes(2)

      // Second failure: the wait doubles to two intervals.
      clock.advance(PR_WATCH_INTERVAL_MS)
      await watcher.tick()
      expect(fetchSnapshot).toHaveBeenCalledTimes(2)
      clock.advance(PR_WATCH_INTERVAL_MS)
      await watcher.tick()
      expect(fetchSnapshot).toHaveBeenCalledTimes(3)
    })

    it('polls a quiet PR less often than an active one', async () => {
      fetchSnapshot.mockResolvedValue(openSnapshot({ checks: [] }))
      watcher.register('task-1', URL_PR, { explicit: false })
      await watcher.tick()
      expect(fetchSnapshot).toHaveBeenCalledTimes(1)

      // Still active: due one interval later.
      clock.advance(PR_WATCH_INTERVAL_MS)
      await watcher.tick()
      expect(fetchSnapshot).toHaveBeenCalledTimes(2)

      // Quiet for 30 minutes: the next poll waits five minutes, not one.
      clock.advance(PR_WATCH_IDLE_AFTER_MS)
      await watcher.tick()
      expect(fetchSnapshot).toHaveBeenCalledTimes(3)
      clock.advance(PR_WATCH_INTERVAL_MS)
      await watcher.tick()
      expect(fetchSnapshot).toHaveBeenCalledTimes(3)
      clock.advance(PR_WATCH_IDLE_INTERVAL_MS - PR_WATCH_INTERVAL_MS)
      await watcher.tick()
      expect(fetchSnapshot).toHaveBeenCalledTimes(4)
    })

    it('stop() waits for the poll in flight before it resolves', async () => {
      watcher.register('task-1', URL_PR, { explicit: false })
      let release!: () => void
      fetchSnapshot.mockImplementationOnce(() => new Promise<PullRequestWatchSnapshot>((resolve) => {
        release = () => resolve(openSnapshot())
      }))
      const poll = watcher.tick()
      let stopped = false
      const stopping = watcher.stop().then(() => { stopped = true })
      await Promise.resolve()
      expect(stopped).toBe(false)
      release()
      await poll
      await stopping
      expect(stopped).toBe(true)
    })

    it('makes no requests while the task has switched watching off, and resumes when it is switched on', async () => {
      watcher.register('task-1', URL_PR, { explicit: false })
      fake.tasks.get('task-1')!.pr_watch_enabled = false
      await watcher.tick()
      expect(fetchSnapshot).not.toHaveBeenCalled()

      fake.tasks.get('task-1')!.pr_watch_enabled = true
      clock.advance(PR_WATCH_INTERVAL_MS)
      await watcher.tick()
      expect(fetchSnapshot).toHaveBeenCalledTimes(1)
      expect(sendByTaskId).toHaveBeenCalledTimes(1)
    })

    it('honours the global switch unless the task overrides it', async () => {
      fake.settings.set(PR_WATCH_ENABLED_SETTING, 'false')
      watcher.register('task-1', URL_PR, { explicit: false })
      await watcher.tick()
      expect(fetchSnapshot).not.toHaveBeenCalled()

      fake.tasks.get('task-1')!.pr_watch_enabled = true
      clock.advance(PR_WATCH_INTERVAL_MS)
      await watcher.tick()
      expect(fetchSnapshot).toHaveBeenCalledTimes(1)
    })

    it('omits the ready notice when the setting turns it off', async () => {
      fake.settings.set(PR_WATCH_READY_SETTING, 'false')
      fetchSnapshot.mockResolvedValue(openSnapshot({ checks: [{ name: 'build', completed: true, conclusion: 'SUCCESS', runId: 'run-1' }] }))
      watcher.register('task-1', URL_PR, { explicit: false })
      await watcher.tick()
      expect(sendByTaskId).not.toHaveBeenCalled()
    })

    it('sends a ready notice when every check passes', async () => {
      fetchSnapshot.mockResolvedValue(openSnapshot({ checks: [{ name: 'build', completed: true, conclusion: 'SUCCESS', runId: 'run-1' }] }))
      watcher.register('task-1', URL_PR, { explicit: false })
      await watcher.tick()
      expect(sendByTaskId).toHaveBeenCalledTimes(1)
      expect(sendByTaskId.mock.calls[0][1]).toContain('ready for a human to merge')
    })

    it('keeps the cursor unchanged when GitHub cannot be read', async () => {
      watcher.register('task-1', URL_PR, { explicit: false })
      fetchSnapshot.mockRejectedValueOnce(new Error('network down'))
      await watcher.tick()
      expect(sendByTaskId).not.toHaveBeenCalled()
      expect(fake.watches.get('task-1|' + URL_PR)?.seen_keys).toEqual([])
    })

    it('does not poll twice at the same time', async () => {
      watcher.register('task-1', URL_PR, { explicit: false })
      let release!: () => void
      fetchSnapshot.mockImplementationOnce(() => new Promise<PullRequestWatchSnapshot>((resolve) => {
        release = () => resolve(openSnapshot())
      }))
      const first = watcher.tick()
      void watcher.tick()
      expect(fetchSnapshot).toHaveBeenCalledTimes(1)
      release()
      await first
    })
  })
})
