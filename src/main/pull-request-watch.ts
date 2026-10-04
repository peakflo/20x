/**
 * Pure rules for watching a pull request and waking the task's agent.
 *
 * The watcher polls a PR snapshot (checks, comments, mergeable state) and asks
 * this module what is new. Nothing here performs I/O, so the diffing, dedupe,
 * wake gating and message formatting can be tested without GitHub or an agent.
 *
 * Dedupe model: every event has a stable key derived from the PR state it
 * describes (commit SHA + check name for CI, comment id for reviews, commit SHA
 * for conflicts and readiness). The watcher stores the keys it has already
 * reported, so an event is delivered at most once.
 */
import { buildSystemMessage, computeDeliveryId, SystemMessageOrigin } from '../shared/system-authority'

/** Poll cadence for every watched PR. */
export const PR_WATCH_INTERVAL_MS = 60_000

export { PR_WATCH_ENABLED_SETTING, PR_WATCH_READY_SETTING } from '../shared/pull-request-watch-settings'

/** Cap on remembered keys per PR, so the cursor cannot grow without bound. */
export const PR_WATCH_MAX_SEEN_KEYS = 1000

/** Cap on events listed in one wake message. */
const MAX_EVENTS_PER_MESSAGE = 20
const EXCERPT_LENGTH = 240

const GITHUB_PULL_REQUEST_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i

/** Conclusions that count as a failed check. */
const FAILING_CONCLUSIONS = new Set([
  'FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'
])
/** Conclusions that count as a passing check. */
const PASSING_CONCLUSIONS = new Set(['SUCCESS'])
/** Conclusions that neither pass nor fail the PR. */
const NEUTRAL_CONCLUSIONS = new Set(['NEUTRAL', 'SKIPPED'])

export interface ParsedPullRequestUrl {
  url: string
  owner: string
  repo: string
  number: number
}

/** Accepts a GitHub pull request URL and returns its canonical form, or null. */
export function parseWatchablePullRequestUrl(input: string): ParsedPullRequestUrl | null {
  const trimmed = input.trim()
  const match = trimmed.match(GITHUB_PULL_REQUEST_URL)
  if (!match) return null
  const [, owner, repo, number] = match
  return {
    url: `https://github.com/${owner}/${repo}/pull/${Number(number)}`,
    owner,
    repo,
    number: Number(number)
  }
}

export interface PullRequestCheckSnapshot {
  name: string
  /** True once the check has finished. */
  completed: boolean
  /** Upper-case conclusion, for example SUCCESS or FAILURE. Empty while pending. */
  conclusion: string
  url?: string
}

export interface PullRequestCommentSnapshot {
  /** Which GitHub collection the item came from. */
  kind: 'review_comment' | 'issue_comment' | 'review'
  id: string
  author: string
  body: string
  path?: string
  line?: number
  url?: string
}

export interface PullRequestWatchSnapshot {
  url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  headSha: string
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | string
  reviewDecision: string
  checks: PullRequestCheckSnapshot[]
  /** Comments and reviews that are not authored by the watching user. */
  comments: PullRequestCommentSnapshot[]
}

export type PullRequestWatchEvent =
  | { kind: 'check_failed'; key: string; headSha: string; checkName: string; conclusion: string; url?: string }
  | {
      kind: 'comment'
      key: string
      commentKind: PullRequestCommentSnapshot['kind']
      author: string
      body: string
      path?: string
      line?: number
      url?: string
    }
  | { kind: 'conflict'; key: string; headSha: string }
  | { kind: 'ready'; key: string; headSha: string }

export interface DiffOptions {
  notifyReady: boolean
}

function shortSha(sha: string): string {
  return sha ? sha.slice(0, 7) : 'unknown'
}

function commentKey(comment: PullRequestCommentSnapshot): string {
  return `comment:${comment.kind}:${comment.id}`
}

/** True when every check is finished and none of them failed, with at least one pass. */
function allChecksPassing(checks: PullRequestCheckSnapshot[]): boolean {
  if (checks.length === 0) return false
  if (!checks.every((check) => check.completed)) return false
  if (checks.some((check) => FAILING_CONCLUSIONS.has(check.conclusion))) return false
  if (!checks.some((check) => PASSING_CONCLUSIONS.has(check.conclusion))) return false
  return checks.every((check) => PASSING_CONCLUSIONS.has(check.conclusion) || NEUTRAL_CONCLUSIONS.has(check.conclusion))
}

/**
 * Compare a snapshot with the keys already reported and return the new events.
 * Pure: it neither reads nor writes the cursor. The caller records the returned
 * event keys after it has decided what to do with them.
 */
export function diffPullRequestSnapshot(
  snapshot: PullRequestWatchSnapshot,
  seenKeys: ReadonlySet<string>,
  options: DiffOptions
): PullRequestWatchEvent[] {
  if (snapshot.state !== 'OPEN') return []
  const events: PullRequestWatchEvent[] = []
  const sha = snapshot.headSha

  for (const check of snapshot.checks) {
    if (!check.completed || !FAILING_CONCLUSIONS.has(check.conclusion)) continue
    const key = `check:${sha}:${check.name}:${check.conclusion}`
    if (seenKeys.has(key)) continue
    events.push({ kind: 'check_failed', key, headSha: sha, checkName: check.name, conclusion: check.conclusion, url: check.url })
  }

  for (const comment of snapshot.comments) {
    const key = commentKey(comment)
    if (seenKeys.has(key)) continue
    events.push({
      kind: 'comment',
      key,
      commentKind: comment.kind,
      author: comment.author,
      body: comment.body,
      path: comment.path,
      line: comment.line,
      url: comment.url
    })
  }

  if (snapshot.mergeable === 'CONFLICTING') {
    const key = `conflict:${sha}`
    if (!seenKeys.has(key)) events.push({ kind: 'conflict', key, headSha: sha })
  }

  if (
    options.notifyReady &&
    !snapshot.isDraft &&
    snapshot.mergeable === 'MERGEABLE' &&
    snapshot.reviewDecision !== 'CHANGES_REQUESTED' &&
    allChecksPassing(snapshot.checks)
  ) {
    const key = `ready:${sha}`
    if (!seenKeys.has(key)) events.push({ kind: 'ready', key, headSha: sha })
  }

  return events
}

/** Keys to remember for a set of events, appended after the existing ones and capped. */
export function mergeSeenKeys(existing: readonly string[], events: readonly PullRequestWatchEvent[]): string[] {
  const merged = [...existing]
  for (const event of events) {
    if (!merged.includes(event.key)) merged.push(event.key)
  }
  return merged.length > PR_WATCH_MAX_SEEN_KEYS
    ? merged.slice(merged.length - PR_WATCH_MAX_SEEN_KEYS)
    : merged
}

export type WakeDecision = 'wake' | 'queue' | 'drop'

export interface WakeInput {
  /** Task status. Completed tasks never wake. */
  taskStatus: string
  /** True when the task has an agent assigned or a live session. */
  hasAgent: boolean
  /** Live session status, or null when no session is running. */
  sessionStatus: string | null
}

/**
 * Decide whether pending events go to the agent now.
 * - drop: the task is completed, so the events no longer matter.
 * - queue: no agent yet, or the agent is busy. Keep the events until it is idle.
 * - wake: the agent is idle (or stopped and resumable) and can take a message now.
 */
export function evaluateWakeCondition(input: WakeInput): WakeDecision {
  if (input.taskStatus === 'completed') return 'drop'
  if (!input.hasAgent) return 'queue'
  // An error or stopped session is not busy. sendByTaskId resumes it.
  if (input.sessionStatus && input.sessionStatus !== 'idle' && input.sessionStatus !== 'error') return 'queue'
  return 'wake'
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH - 1)}…` : flat
}

function describeEvent(event: PullRequestWatchEvent): string {
  switch (event.kind) {
    case 'check_failed': {
      const link = event.url ? ` ${event.url}` : ''
      return `- CI check "${event.checkName}" failed on commit ${shortSha(event.headSha)} (${event.conclusion.toLowerCase()}).${link} Investigate the failure and fix it.`
    }
    case 'comment': {
      const location = event.path ? ` on ${event.path}${event.line ? `:${event.line}` : ''}` : ''
      const what = event.commentKind === 'review' ? 'review' : 'review comment'
      const link = event.url ? ` ${event.url}` : ''
      const body = excerpt(event.body) || '(no text)'
      return `- New ${what} from @${event.author}${location}: "${body}"${link}`
    }
    case 'conflict':
      return `- The PR has a merge conflict with its base branch (commit ${shortSha(event.headSha)}). Update the branch and resolve the conflict.`
    case 'ready':
      return `- All checks pass and the PR is mergeable (commit ${shortSha(event.headSha)}). It is ready for a human to merge. Do not merge it yourself.`
  }
}

/**
 * Build the wake message for an agent. It is machine-authored, so it uses the
 * system-message envelope: the provenance header, the fenced data block and the
 * authority notice. Any comment text inside it is quoted data, not instructions.
 */
export function formatPullRequestWakeMessage(
  taskId: string,
  prUrl: string,
  events: readonly PullRequestWatchEvent[],
  now: Date = new Date()
): string {
  const listed = events.slice(0, MAX_EVENTS_PER_MESSAGE).map(describeEvent)
  const hidden = events.length - listed.length
  if (hidden > 0) listed.push(`- ...and ${hidden} more. Check the PR for the rest.`)
  const findings = listed.join('\n')
  const deliveryId = computeDeliveryId(taskId, `${prUrl}\n${findings}`)
  return buildSystemMessage(
    {
      origin: SystemMessageOrigin.PullRequestWatch,
      taskId,
      deliveryId,
      generatedAt: now.toISOString()
    },
    `20x is watching the pull request ${prUrl} for this task and found new activity. Work on the items below in this workspace, push any fixes, and report back briefly.`,
    findings
  )
}
