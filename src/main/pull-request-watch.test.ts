import { describe, expect, it } from 'vitest'
import {
  PR_WATCH_MAX_SEEN_KEYS,
  diffPullRequestSnapshot,
  evaluateWakeCondition,
  formatPullRequestWakeMessage,
  mergeSeenKeys,
  parseWatchablePullRequestUrl,
  type PullRequestWatchEvent,
  type PullRequestWatchSnapshot
} from './pull-request-watch'
import { SYSTEM_MESSAGE_MARKER } from '../shared/system-authority'

const URL_PR = 'https://github.com/acme/app/pull/42'

function snapshot(overrides: Partial<PullRequestWatchSnapshot> = {}): PullRequestWatchSnapshot {
  return {
    url: URL_PR,
    state: 'OPEN',
    isDraft: false,
    headSha: 'abcdef1234567',
    mergeable: 'MERGEABLE',
    reviewDecision: '',
    checks: [{ name: 'build', completed: true, conclusion: 'SUCCESS' }],
    comments: [],
    ...overrides
  }
}

const NO_SEEN = new Set<string>()
const READY_ON = { notifyReady: true }

describe('parseWatchablePullRequestUrl', () => {
  it('accepts GitHub pull request URLs and canonicalises them', () => {
    expect(parseWatchablePullRequestUrl('https://github.com/acme/app/pull/42/files?x=1')).toEqual({
      url: URL_PR,
      owner: 'acme',
      repo: 'app',
      number: 42
    })
  })

  it('rejects issues, other hosts and non-PR paths', () => {
    expect(parseWatchablePullRequestUrl('https://github.com/acme/app/issues/42')).toBeNull()
    expect(parseWatchablePullRequestUrl('https://gitlab.com/acme/app/-/merge_requests/42')).toBeNull()
    expect(parseWatchablePullRequestUrl('not a url')).toBeNull()
  })
})

describe('diffPullRequestSnapshot', () => {
  it('reports a failed check once per commit and check name', () => {
    const failing = snapshot({ checks: [{ name: 'build', completed: true, conclusion: 'FAILURE', url: 'https://ci/1' }] })
    const first = diffPullRequestSnapshot(failing, NO_SEEN, READY_ON)
    expect(first).toEqual([
      expect.objectContaining({ kind: 'check_failed', checkName: 'build', conclusion: 'FAILURE', key: 'check:abcdef1234567:build:FAILURE' })
    ])

    const seen = new Set(first.map((event) => event.key))
    expect(diffPullRequestSnapshot(failing, seen, READY_ON)).toEqual([])
  })

  it('does not report checks that are still running', () => {
    const running = snapshot({ checks: [{ name: 'build', completed: false, conclusion: '' }] })
    expect(diffPullRequestSnapshot(running, NO_SEEN, READY_ON).filter((e) => e.kind === 'check_failed')).toEqual([])
  })

  it('reports a failure again after a new commit', () => {
    const before = snapshot({ checks: [{ name: 'build', completed: true, conclusion: 'FAILURE' }] })
    const seen = new Set(diffPullRequestSnapshot(before, NO_SEEN, READY_ON).map((e) => e.key))
    const after = snapshot({ headSha: 'fff0000aaaa', checks: [{ name: 'build', completed: true, conclusion: 'FAILURE' }] })
    expect(diffPullRequestSnapshot(after, seen, READY_ON).map((e) => e.kind)).toEqual(['check_failed'])
  })

  it('reports each new review comment once, keyed by its id', () => {
    const comment = { kind: 'review_comment' as const, id: '901', author: 'reviewer', body: 'Rename this', path: 'src/a.ts', line: 7 }
    const quiet = { notifyReady: false }
    const events = diffPullRequestSnapshot(snapshot({ comments: [comment] }), NO_SEEN, quiet)
    expect(events).toEqual([
      expect.objectContaining({ kind: 'comment', key: 'comment:review_comment:901', author: 'reviewer', path: 'src/a.ts', line: 7 })
    ])
    const seen = new Set(events.map((e) => e.key))
    expect(diffPullRequestSnapshot(snapshot({ comments: [comment] }), seen, quiet)).toEqual([])
  })

  it('reports a merge conflict once per commit', () => {
    const conflicting = snapshot({ mergeable: 'CONFLICTING' })
    const events = diffPullRequestSnapshot(conflicting, NO_SEEN, READY_ON)
    expect(events.map((e) => e.kind)).toEqual(['conflict'])
    expect(diffPullRequestSnapshot(conflicting, new Set(events.map((e) => e.key)), READY_ON)).toEqual([])
  })

  it('reports ready only when every check passed and the PR is mergeable', () => {
    expect(diffPullRequestSnapshot(snapshot(), NO_SEEN, READY_ON).map((e) => e.kind)).toEqual(['ready'])
    expect(diffPullRequestSnapshot(snapshot(), NO_SEEN, { notifyReady: false })).toEqual([])
    expect(diffPullRequestSnapshot(snapshot({ isDraft: true }), NO_SEEN, READY_ON)).toEqual([])
    expect(diffPullRequestSnapshot(snapshot({ reviewDecision: 'CHANGES_REQUESTED' }), NO_SEEN, READY_ON)).toEqual([])
    expect(diffPullRequestSnapshot(snapshot({ mergeable: 'UNKNOWN' }), NO_SEEN, READY_ON)).toEqual([])
    expect(diffPullRequestSnapshot(snapshot({ checks: [] }), NO_SEEN, READY_ON)).toEqual([])
    const pending = snapshot({ checks: [{ name: 'build', completed: true, conclusion: 'SUCCESS' }, { name: 'e2e', completed: false, conclusion: '' }] })
    expect(diffPullRequestSnapshot(pending, NO_SEEN, READY_ON)).toEqual([])
  })

  it('does not report ready when a check failed', () => {
    const mixed = snapshot({
      checks: [
        { name: 'build', completed: true, conclusion: 'SUCCESS' },
        { name: 'lint', completed: true, conclusion: 'FAILURE' }
      ]
    })
    const kinds = diffPullRequestSnapshot(mixed, NO_SEEN, READY_ON).map((e) => e.kind)
    expect(kinds).toEqual(['check_failed'])
  })

  it('reports nothing once the PR is merged or closed', () => {
    const merged = snapshot({ state: 'MERGED', checks: [{ name: 'build', completed: true, conclusion: 'FAILURE' }] })
    expect(diffPullRequestSnapshot(merged, NO_SEEN, READY_ON)).toEqual([])
  })
})

describe('mergeSeenKeys', () => {
  it('appends new keys without duplicates', () => {
    const events: PullRequestWatchEvent[] = [{ kind: 'conflict', key: 'conflict:a', headSha: 'a' }]
    expect(mergeSeenKeys(['x'], events)).toEqual(['x', 'conflict:a'])
    expect(mergeSeenKeys(['conflict:a'], events)).toEqual(['conflict:a'])
  })

  it('keeps only the most recent keys', () => {
    const existing = Array.from({ length: PR_WATCH_MAX_SEEN_KEYS }, (_, i) => `k${i}`)
    const events: PullRequestWatchEvent[] = [{ kind: 'conflict', key: 'new', headSha: 'a' }]
    const merged = mergeSeenKeys(existing, events)
    expect(merged).toHaveLength(PR_WATCH_MAX_SEEN_KEYS)
    expect(merged.at(-1)).toBe('new')
    expect(merged).not.toContain('k0')
  })
})

describe('evaluateWakeCondition', () => {
  const base = { taskStatus: 'agent_working', hasAgent: true, sessionStatus: 'idle' }

  it('wakes an idle agent', () => {
    expect(evaluateWakeCondition(base)).toBe('wake')
  })

  it('wakes a stopped or errored session, which sendByTaskId resumes', () => {
    expect(evaluateWakeCondition({ ...base, sessionStatus: null })).toBe('wake')
    expect(evaluateWakeCondition({ ...base, sessionStatus: 'error' })).toBe('wake')
  })

  it('queues while the agent is working or waiting for approval', () => {
    expect(evaluateWakeCondition({ ...base, sessionStatus: 'working' })).toBe('queue')
    expect(evaluateWakeCondition({ ...base, sessionStatus: 'waiting_approval' })).toBe('queue')
  })

  it('queues when the task has no agent', () => {
    expect(evaluateWakeCondition({ ...base, hasAgent: false, sessionStatus: null })).toBe('queue')
  })

  it('drops events for completed tasks', () => {
    expect(evaluateWakeCondition({ ...base, taskStatus: 'completed' })).toBe('drop')
  })
})

describe('formatPullRequestWakeMessage', () => {
  const fixedNow = new Date('2026-10-05T10:00:00.000Z')

  it('wraps the findings in the machine-message envelope with the authority notice', () => {
    const message = formatPullRequestWakeMessage('task-1', URL_PR, [
      { kind: 'check_failed', key: 'k1', headSha: 'abcdef1234567', checkName: 'build', conclusion: 'FAILURE', url: 'https://ci/1' }
    ], fixedNow)
    expect(message.startsWith(SYSTEM_MESSAGE_MARKER)).toBe(true)
    expect(message).toContain('origin=pull-request-watcher')
    expect(message).toContain('human_authored=false')
    expect(message).toContain('CI check "build" failed on commit abcdef1')
    expect(message).toContain('https://ci/1')
    expect(message).toContain('AUTHORITY BOUNDARY')
  })

  it('quotes comment text as data and shortens long bodies', () => {
    const body = 'word '.repeat(200)
    const message = formatPullRequestWakeMessage('task-1', URL_PR, [
      { kind: 'comment', key: 'k2', commentKind: 'review_comment', author: 'alice', body, path: 'src/x.ts', line: 3 }
    ], fixedNow)
    expect(message).toContain('New review comment from @alice on src/x.ts:3:')
    expect(message).toContain('…')
    expect(message).not.toContain(body.trim())
  })

  it('describes conflicts and readiness without asking for a merge', () => {
    const message = formatPullRequestWakeMessage('task-1', URL_PR, [
      { kind: 'conflict', key: 'c', headSha: 'abcdef1234567' },
      { kind: 'ready', key: 'r', headSha: 'abcdef1234567' }
    ], fixedNow)
    expect(message).toContain('merge conflict')
    expect(message).toContain('Do not merge it yourself')
  })

  it('caps the list and says how many were left out', () => {
    const events: PullRequestWatchEvent[] = Array.from({ length: 25 }, (_, i) => ({
      kind: 'comment' as const, key: `k${i}`, commentKind: 'issue_comment' as const, author: 'bot', body: `note ${i}`
    }))
    const message = formatPullRequestWakeMessage('task-1', URL_PR, events, fixedNow)
    expect(message).toContain('...and 5 more')
    expect(message).not.toContain('note 24')
  })
})
