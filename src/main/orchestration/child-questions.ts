/**
 * Children's questions and approvals go to the parent first.
 *
 * Problem this replaces: a subtask that raised an approval request or a
 * question (AskUserQuestion / the `question` tool / `waiting_approval` /
 * Codex and ACP permission requests) went straight to a human push/OS
 * notification. The parent coordinator — which assigned the subtask and
 * knows the plan — only ever saw it if it happened to poll
 * `list_pending_approvals`. This module lets the parent answer within its
 * own authority first, and falls back to the human when it can't or
 * shouldn't.
 *
 * Routing, in order:
 * 1. No parent, parent completed, the parent's own session can't reach these
 *    tools (nested scoped), the "route to parent" setting is off, the
 *    parent's own `permission_mode` is `ask` (it has no standing authority to
 *    grant), or the request needs an operation the authority gate reserves
 *    for a human (default-deny: see `command-authority.ts` for the shell/
 *    network/file-write side, `system-authority.ts` for the free-text side)
 *    → straight to the human (today's push/OS notification), with the
 *    parent still told, for information. None of these wait for the
 *    escalation timeout — they escalate immediately.
 * 2. Otherwise → a durable, deduplicated wake-up to the parent (reusing
 *    `task_wakeups`/`TaskWakeupQueue` — reason `child_question`), with an
 *    escalation deadline. If the parent hasn't answered by then (or was never
 *    reachable), an idle sweep escalates to the human automatically.
 *
 * Concurrency: every transition out of `pending_parent`/`escalated` goes
 * through `ChildQuestionStore.claim`, an atomic `UPDATE ... WHERE state IN
 * (...)` — only one caller's claim can ever succeed for a given question, so
 * the parent and a human (or two parent calls) can never both reach the
 * harness for the same request. A failed adapter call reverts the claim.
 *
 * The parent answers through `answerFromParent`, and a human answers directly
 * through `answerAsHuman` — both drive the exact same adapter call
 * (`answerChildSession`, passing the question's own id as the harness's
 * `requestId` so a stale/mismatched request is refused rather than silently
 * answering whatever happens to be pending right now) — so every harness
 * (Claude Code, Codex, OpenCode, Pi, ACP) is answered the same way regardless
 * of who answered.
 */

import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { evaluateAuthorityGate } from '../../shared/system-authority'
import { classifyCommandAuthority } from './command-authority'
import { subtaskEvents } from './subtask-events'
import { isLiveChildQuestionState } from '../../shared/child-questions'
import type {
  ChildQuestionAnsweredBy,
  ChildQuestionKind,
  ChildQuestionOption,
  ChildQuestionRecord,
  ChildQuestionState
} from '../../shared/child-questions'

export type {
  ChildQuestionAnsweredBy,
  ChildQuestionKind,
  ChildQuestionOption,
  ChildQuestionRecord,
  ChildQuestionState
} from '../../shared/child-questions'

interface ChildQuestionRow {
  id: string
  child_task_id: string
  parent_task_id: string | null
  question_id: string
  kind: string
  question_text: string
  options: string | null
  tool_name: string | null
  command: string | null
  context_excerpt: string | null
  requires_human: number
  authority_categories: string
  state: string
  answer: string | null
  option_id: string | null
  note: string | null
  answered_by: string | null
  created_at: number
  updated_at: number
  escalate_at: number | null
  escalated_at: number | null
  answered_at: number | null
}

function fromRow(row: ChildQuestionRow): ChildQuestionRecord {
  return {
    id: row.id,
    childTaskId: row.child_task_id,
    parentTaskId: row.parent_task_id,
    questionId: row.question_id,
    kind: row.kind as ChildQuestionKind,
    questionText: row.question_text,
    options: row.options ? (JSON.parse(row.options) as ChildQuestionOption[]) : null,
    toolName: row.tool_name,
    command: row.command,
    contextExcerpt: row.context_excerpt,
    requiresHuman: !!row.requires_human,
    authorityCategories: row.authority_categories ? (JSON.parse(row.authority_categories) as string[]) : [],
    state: row.state as ChildQuestionState,
    answer: row.answer,
    optionId: row.option_id,
    note: row.note,
    answeredBy: (row.answered_by as ChildQuestionAnsweredBy | null) ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    escalateAt: row.escalate_at,
    escalatedAt: row.escalated_at,
    answeredAt: row.answered_at
  }
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS child_questions (
    id TEXT PRIMARY KEY,
    child_task_id TEXT NOT NULL,
    parent_task_id TEXT,
    question_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    question_text TEXT NOT NULL,
    options TEXT,
    tool_name TEXT,
    command TEXT,
    context_excerpt TEXT,
    requires_human INTEGER NOT NULL DEFAULT 0,
    authority_categories TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL,
    answer TEXT,
    option_id TEXT,
    note TEXT,
    answered_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    escalate_at INTEGER,
    escalated_at INTEGER,
    answered_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_child_questions_child_question ON child_questions(child_task_id, question_id);
  CREATE INDEX IF NOT EXISTS idx_child_questions_parent_state ON child_questions(parent_task_id, state);
  CREATE INDEX IF NOT EXISTS idx_child_questions_escalate_at ON child_questions(state, escalate_at);
`

export interface CreateChildQuestionInput {
  childTaskId: string
  parentTaskId: string | null
  questionId: string
  kind: ChildQuestionKind
  questionText: string
  options: ChildQuestionOption[] | null
  toolName: string | null
  command: string | null
  contextExcerpt: string | null
  requiresHuman: boolean
  authorityCategories: string[]
  state: ChildQuestionState
  escalateAt: number | null
}

export interface UpdateChildQuestionStatePatch {
  state: ChildQuestionState
  answer?: string | null
  optionId?: string | null
  note?: string | null
  answeredBy?: ChildQuestionAnsweredBy | null
  escalatedAt?: number | null
  answeredAt?: number | null
}

const LIVE_STATES = ['pending_parent', 'answering', 'escalated']

export class ChildQuestionStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(SCHEMA_SQL)
  }

  /** Returns null when (child_task_id, question_id) was already created — the exact same question is never enqueued twice. */
  create(input: CreateChildQuestionInput, nowMs: number): ChildQuestionRecord | null {
    const id = randomUUID()
    try {
      this.db
        .prepare(
          `INSERT INTO child_questions (
            id, child_task_id, parent_task_id, question_id, kind, question_text, options,
            tool_name, command, context_excerpt, requires_human, authority_categories, state,
            answer, option_id, note, answered_by, created_at, updated_at, escalate_at, escalated_at, answered_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, NULL)`
        )
        .run(
          id,
          input.childTaskId,
          input.parentTaskId,
          input.questionId,
          input.kind,
          input.questionText,
          input.options ? JSON.stringify(input.options) : null,
          input.toolName,
          input.command,
          input.contextExcerpt,
          input.requiresHuman ? 1 : 0,
          JSON.stringify(input.authorityCategories),
          input.state,
          nowMs,
          nowMs,
          input.escalateAt
        )
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) return null
      throw err
    }
    return this.get(id)
  }

  get(id: string): ChildQuestionRecord | null {
    const row = this.db.prepare('SELECT * FROM child_questions WHERE id = ?').get(id) as ChildQuestionRow | undefined
    return row ? fromRow(row) : null
  }

  getByChildAndQuestionId(childTaskId: string, questionId: string): ChildQuestionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM child_questions WHERE child_task_id = ? AND question_id = ?')
      .get(childTaskId, questionId) as ChildQuestionRow | undefined
    return row ? fromRow(row) : null
  }

  listForChild(childTaskId: string): ChildQuestionRecord[] {
    return (
      this.db.prepare('SELECT * FROM child_questions WHERE child_task_id = ? ORDER BY created_at').all(childTaskId) as ChildQuestionRow[]
    ).map(fromRow)
  }

  listForParent(parentTaskId: string): ChildQuestionRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM child_questions WHERE parent_task_id = ? ORDER BY created_at')
        .all(parentTaskId) as ChildQuestionRow[]
    ).map(fromRow)
  }

  /** The single live (pending_parent/answering/escalated) row for a child, if any — used when an exact question id isn't available (e.g. a plain chat answer to a "question"-kind request). */
  latestLiveForChild(childTaskId: string): ChildQuestionRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM child_questions WHERE child_task_id = ? AND state IN (${LIVE_STATES.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 1`
      )
      .get(childTaskId, ...LIVE_STATES) as ChildQuestionRow | undefined
    return row ? fromRow(row) : null
  }

  /** Rows still waiting on the parent whose deadline has passed — the automatic-escalation sweep's input. */
  listPendingPastEscalateAt(nowMs: number): ChildQuestionRecord[] {
    return (
      this.db
        .prepare(`SELECT * FROM child_questions WHERE state = 'pending_parent' AND escalate_at IS NOT NULL AND escalate_at <= ?`)
        .all(nowMs) as ChildQuestionRow[]
    ).map(fromRow)
  }

  /**
   * Atomically claims a live row for answering — `UPDATE ... WHERE state IN
   * (pending_parent, escalated)`, so exactly one concurrent caller's claim
   * succeeds. Returns false (does nothing) when the row is already being
   * answered or is already resolved.
   */
  claim(id: string, nowMs: number): boolean {
    const result = this.db
      .prepare(`UPDATE child_questions SET state = 'answering', updated_at = ? WHERE id = ? AND state IN ('pending_parent', 'escalated')`)
      .run(nowMs, id)
    return result.changes === 1
  }

  /** Reverts a claim after the adapter call it was held for failed — back to `escalated` if it had been escalated, `pending_parent` otherwise. */
  revertClaim(id: string, nowMs: number): void {
    this.db
      .prepare(
        `UPDATE child_questions SET state = CASE WHEN escalated_at IS NOT NULL THEN 'escalated' ELSE 'pending_parent' END, updated_at = ? WHERE id = ? AND state = 'answering'`
      )
      .run(nowMs, id)
  }

  /** Escalates a row atomically, only from `pending_parent` — races safely against a concurrent claim/answer. */
  claimAndEscalate(id: string, note: string | null, nowMs: number): boolean {
    const result = this.db
      .prepare(`UPDATE child_questions SET state = 'escalated', note = COALESCE(?, note), escalated_at = ?, updated_at = ? WHERE id = ? AND state = 'pending_parent'`)
      .run(note, nowMs, nowMs, id)
    return result.changes === 1
  }

  updateState(id: string, patch: UpdateChildQuestionStatePatch, nowMs: number): void {
    this.db
      .prepare(
        `UPDATE child_questions SET
          state = ?,
          answer = COALESCE(?, answer),
          option_id = COALESCE(?, option_id),
          note = COALESCE(?, note),
          answered_by = COALESCE(?, answered_by),
          escalated_at = COALESCE(?, escalated_at),
          answered_at = COALESCE(?, answered_at),
          updated_at = ?
        WHERE id = ?`
      )
      .run(
        patch.state,
        patch.answer ?? null,
        patch.optionId ?? null,
        patch.note ?? null,
        patch.answeredBy ?? null,
        patch.escalatedAt ?? null,
        patch.answeredAt ?? null,
        nowMs,
        id
      )
  }

  /** Marks every still-live row for a child `cancelled` — the child's turn ended, its session stopped, its task completed, or a newer request superseded it. Not "answered" by anyone; just moot. */
  cancelLive(childTaskId: string, nowMs: number, exceptQuestionId?: string): number {
    const clause = exceptQuestionId
      ? `AND question_id != ?`
      : ''
    const args: unknown[] = [nowMs, childTaskId, ...LIVE_STATES]
    if (exceptQuestionId) args.push(exceptQuestionId)
    const result = this.db
      .prepare(
        `UPDATE child_questions SET state = 'cancelled', updated_at = ? WHERE child_task_id = ? AND state IN (${LIVE_STATES.map(() => '?').join(',')}) ${clause}`
      )
      .run(...args)
    return result.changes
  }
}

// ── Local, minimal secret scrubbing for the context excerpt ──────────────
// A dedicated scrubbing utility is being built in a sibling PR; this is a
// small, self-contained stand-in so this feature doesn't depend on that PR's
// merge order. Safe to swap for the shared one once it lands.
const SECRET_LIKE_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi,
  /\b(api[_-]?key|secret|token|password|passwd)\s*[:=]\s*['"]?[^\s'"]{6,}['"]?/gi
]

export function scrubSecretsForExcerpt(text: string, maxLength = 400): string {
  let scrubbed = text
  for (const pattern of SECRET_LIKE_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, '[redacted]')
  }
  return scrubbed.length > maxLength ? `${scrubbed.slice(0, maxLength)}…` : scrubbed
}

export const DEFAULT_CHILD_QUESTION_ESCALATION_TIMEOUT_MS = 10 * 60 * 1000

export interface ChildQuestionParentPolicy {
  /** Undefined means "inherit the global default". */
  routeToParent?: boolean
  permissionMode?: 'ask' | 'allow'
  escalationTimeoutMs?: number
  /** False when the parent's own session can't reach answer_child_question/escalate_to_user at all (e.g. it is itself a nested scoped subtask session) — such a question escalates immediately, never waiting out the timeout. Defaults to true. */
  canAnswer?: boolean
}

export interface RaiseChildQuestionInput {
  childTaskId: string
  questionId: string
  kind: ChildQuestionKind
  questionText: string
  options?: ChildQuestionOption[] | null
  toolName?: string | null
  command?: string | null
  contextExcerpt?: string | null
  /** The child's workspace directory, when known — lets the authority classifier tell a workspace-local file write from one that escapes it. */
  workspaceDir?: string | null
}

export interface AnswerChildSessionInput {
  approved: boolean
  answer?: string
  optionId?: string
}

export interface ChildQuestionDeps {
  store: ChildQuestionStore
  /** Looks up a task for routing purposes. Returns undefined when the task doesn't exist. */
  getTask: (taskId: string) => { id: string; title: string; status: string; parent_task_id: string | null; agent_id: string | null } | undefined
  /** The parent's effective policy — per-agent override, falling back to the global setting. */
  getParentPolicy: (parentTaskId: string) => ChildQuestionParentPolicy
  /** True when a descendant check for an MCP tool call passes. */
  isDescendant: (ancestorTaskId: string, taskId: string) => boolean
  /** Enqueues (or combines into) the durable parent wake-up queue. Payload shape matches `task-wakeups.ts`'s `WakeupPayload` (duplicated here rather than imported, so this module doesn't couple to that one's internals). */
  enqueueParentWakeup: (input: {
    parentTaskId: string
    childTaskId: string
    deliveryId: string
    payload: { childTitle: string; childStatus: string; [key: string]: unknown }
  }) => Promise<unknown>
  /** Drops a still-undelivered child_question wake-up — used once the question is resolved another way. */
  cancelParentWakeup: (parentTaskId: string, childTaskId: string) => void
  /**
   * Drives the same adapter call the human UI's respond_to_checkpoint/
   * send_message use. `requestId` (the question's own id) is passed through
   * to the harness so a stale/superseded request is refused rather than
   * silently answering whatever happens to be pending right now — throw to
   * signal that (the claim is reverted and the caller gets an error).
   */
  answerChildSession: (childTaskId: string, kind: ChildQuestionKind, input: AnswerChildSessionInput, requestId: string) => Promise<void>
  /** Today's human push/OS notification path. */
  notifyHuman: (childTaskId: string, record: ChildQuestionRecord) => void
  /** Records who answered in the child's transcript. */
  appendTranscriptNote: (childTaskId: string, text: string) => void
  /** Optional: tells the live UI a new question/approval exists (whichever state it landed in) — e.g. a renderer push so the parent and child task views update without polling. */
  notifyRaised?: (childTaskId: string, record: ChildQuestionRecord) => void
  now?: () => number
}

export type AnswerChildQuestionResult =
  | { success: true; record: ChildQuestionRecord }
  | { error: string }

const ESCALATION_SWEEP_INTERVAL_MS = 30 * 1000

export class ChildQuestionService {
  private readonly now: () => number
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: ChildQuestionDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Starts the periodic automatic-escalation sweep (every 30s), plus an immediate pass for anything overdue from before a restart. */
  startSweep(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => this.sweepEscalations(), ESCALATION_SWEEP_INTERVAL_MS)
    this.sweepTimer.unref?.()
    this.sweepEscalations()
  }

  stopSweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
  }

  /**
   * The routing/authority decision `raise()` makes, factored out so a
   * caller (the immediate human-notification suppression in agent-manager.ts,
   * item 11) can preview "would this go to the parent?" synchronously,
   * without writing a row — using the exact same rules `raise()` itself
   * uses, so the preview can never drift out of sync with reality.
   */
  private computeRouting(
    childTask: { id: string; parent_task_id: string | null },
    authorityInput: { toolName?: string | null; command?: string | null; questionText: string; workspaceDir?: string | null }
  ): { mustEscalate: boolean; requiresHuman: boolean; authorityCategories: string[]; parentTaskId: string | null; parentReachable: boolean; timeoutMs: number } {
    const parentTaskId = childTask.parent_task_id
    const parentTask = parentTaskId ? this.deps.getTask(parentTaskId) : undefined
    const policy = parentTaskId ? this.deps.getParentPolicy(parentTaskId) : {}

    const authoritySourceText = [authorityInput.toolName, authorityInput.command, authorityInput.questionText].filter(Boolean).join(' ')
    const proseAuthority = evaluateAuthorityGate(scrubSecretsForExcerpt(authoritySourceText, 4000))
    // The prose gate scans English findings and misses raw command syntax
    // entirely (`git push --force origin main` reads nothing like "merge the
    // PR") — the command gate is default-deny for anything that looks like a
    // shell/network/file-write action, independent of wording.
    // Only fed a real `toolName`/`command` — NOT `questionText`. questionText
    // is an English sentence ("Run tests?"), not command syntax, and feeding
    // it to the command classifier's default-deny allowlist would just
    // misclassify ordinary approvals as unrecognized. When there's no
    // structured command at all, this returns requiresHuman: false and the
    // prose gate above is what's actually doing the classifying.
    const commandAuthority = classifyCommandAuthority({
      toolName: authorityInput.toolName,
      command: authorityInput.command,
      workspaceDir: authorityInput.workspaceDir
    })
    const requiresHuman = proseAuthority.requiresHumanAuthorization || commandAuthority.requiresHuman
    const authorityCategories = [...new Set([...proseAuthority.categories, ...commandAuthority.categories])]

    // A parent under its own `ask` permission mode has no standing authority
    // of its own to grant — it must ask a human for everything, so it cannot
    // grant a child more than that either. A parent whose own session can't
    // even reach these tools (nested scoped) can never answer regardless of
    // authority — both escalate immediately, same as an out-of-authority
    // request, never waiting out the timeout.
    const parentUnderAskMode = policy.permissionMode === 'ask'
    const parentCanAnswer = policy.canAnswer ?? true
    const routeToParent = policy.routeToParent ?? true
    const parentReachable = !!parentTaskId && !!parentTask && parentTask.status !== 'completed'

    const mustEscalate =
      !parentReachable || !routeToParent || parentUnderAskMode || !parentCanAnswer || requiresHuman

    return {
      mustEscalate,
      requiresHuman,
      authorityCategories,
      parentTaskId: parentTaskId ?? null,
      parentReachable,
      timeoutMs: policy.escalationTimeoutMs ?? DEFAULT_CHILD_QUESTION_ESCALATION_TIMEOUT_MS
    }
  }

  /**
   * Preview-only: would raising this question right now escalate straight
   * to the human, or go to the parent? Used to suppress the immediate
   * human push/OS notification for a subtask question that is about to be
   * routed to its parent instead (item 11) — writes nothing, raises
   * nothing.
   */
  wouldEscalate(childTaskId: string, authorityInput: { toolName?: string | null; command?: string | null; questionText: string; workspaceDir?: string | null }): boolean {
    const childTask = this.deps.getTask(childTaskId)
    if (!childTask) return true
    return this.computeRouting(childTask, authorityInput).mustEscalate
  }

  /**
   * Raises a question/approval for one child session. Idempotent: raising
   * the same (childTaskId, questionId) twice returns the original record
   * instead of creating a second one or re-notifying anybody.
   */
  async raise(input: RaiseChildQuestionInput): Promise<ChildQuestionRecord | null> {
    const existing = this.deps.store.getByChildAndQuestionId(input.childTaskId, input.questionId)
    if (existing) return existing

    const childTask = this.deps.getTask(input.childTaskId)
    if (!childTask) return null

    const { mustEscalate, requiresHuman, authorityCategories, parentTaskId, parentReachable, timeoutMs } = this.computeRouting(childTask, input)
    const contextExcerpt = scrubSecretsForExcerpt(
      input.contextExcerpt ?? [input.toolName, input.command, input.questionText].filter(Boolean).join(' ')
    )
    const now = this.now()

    const record = this.deps.store.create(
      {
        childTaskId: input.childTaskId,
        parentTaskId: parentTaskId ?? null,
        questionId: input.questionId,
        kind: input.kind,
        questionText: input.questionText,
        options: input.options ?? null,
        toolName: input.toolName ?? null,
        command: input.command ?? null,
        contextExcerpt,
        requiresHuman,
        authorityCategories,
        state: mustEscalate ? 'escalated' : 'pending_parent',
        escalateAt: mustEscalate ? null : now + timeoutMs
      },
      now
    )
    if (!record) return this.deps.store.getByChildAndQuestionId(input.childTaskId, input.questionId)

    this.deps.notifyRaised?.(input.childTaskId, record)
    subtaskEvents.emitSubtaskEvent({
      kind: 'child_question',
      parentTaskId: parentTaskId ?? childTask.id,
      childTaskId: input.childTaskId,
      questionId: input.questionId,
      needsAttention: true
    })

    if (mustEscalate) {
      this.deps.notifyHuman(input.childTaskId, record)
      // The parent is still told, for information, when it's reachable at all
      // (just not trusted to decide alone — e.g. a deploy approval, or its own
      // permission mode is `ask`).
      if (parentReachable && parentTaskId) {
        await this.deps.enqueueParentWakeup({
          parentTaskId,
          childTaskId: input.childTaskId,
          deliveryId: `${parentTaskId}:${input.childTaskId}:${input.questionId}:escalated`,
          payload: {
            childTitle: childTask.title,
            childStatus: 'escalated_to_human',
            questionId: input.questionId,
            questionText: input.questionText,
            options: input.options ?? null,
            toolName: input.toolName ?? null,
            command: input.command ?? null,
            informational: true
          }
        })
      }
    } else if (parentTaskId) {
      await this.deps.enqueueParentWakeup({
        parentTaskId,
        childTaskId: input.childTaskId,
        deliveryId: `${parentTaskId}:${input.childTaskId}:${input.questionId}`,
        payload: {
          childTitle: childTask.title,
          childStatus: 'waiting_for_parent',
          questionId: input.questionId,
          questionText: input.questionText,
          options: input.options ?? null,
          toolName: input.toolName ?? null,
          command: input.command ?? null,
          kind: input.kind
        }
      })
    }

    return record
  }

  /** Every question raised for one child task, newest first — for the child's own task view. */
  listForChild(childTaskId: string): ChildQuestionRecord[] {
    return [...this.deps.store.listForChild(childTaskId)].reverse()
  }

  /** Every question currently routed to one parent (any state) — for the parent's task view. */
  listForParent(parentTaskId: string): ChildQuestionRecord[] {
    return [...this.deps.store.listForParent(parentTaskId)].reverse()
  }

  /** The current live (pending_parent/answering/escalated) question for one child, if any. */
  getLiveForChild(childTaskId: string): ChildQuestionRecord | null {
    return this.deps.store.latestLiveForChild(childTaskId)
  }

  /** The parent answers within its own authority. Scoped to its own descendants. */
  async answerFromParent(
    callerTaskId: string,
    childTaskId: string,
    questionId: string,
    input: { approved?: boolean; answer?: string; optionId?: string }
  ): Promise<AnswerChildQuestionResult> {
    if (!this.deps.isDescendant(callerTaskId, childTaskId)) {
      return { error: 'That task is not a descendant of this task' }
    }
    const record = this.deps.store.getByChildAndQuestionId(childTaskId, questionId)
    if (!record) return { error: 'No such question for that task' }
    if (record.state !== 'pending_parent') {
      return { error: `That question is already "${record.state}", not waiting for the parent` }
    }
    if (record.kind === 'approval' && typeof input.approved !== 'boolean') {
      return { error: 'approved (true or false) is required for an approval' }
    }

    const claimedAt = this.now()
    if (!this.deps.store.claim(record.id, claimedAt)) {
      return { error: 'That question was just answered another way' }
    }

    try {
      await this.deps.answerChildSession(
        childTaskId,
        record.kind,
        { approved: input.approved ?? false, answer: input.answer, optionId: input.optionId },
        record.questionId
      )
    } catch (err) {
      this.deps.store.revertClaim(record.id, this.now())
      return { error: err instanceof Error ? err.message : 'Failed to deliver the answer' }
    }

    const now = this.now()
    this.deps.store.updateState(
      record.id,
      { state: 'answered_by_parent', answer: input.answer ?? null, optionId: input.optionId ?? null, answeredBy: 'parent', answeredAt: now },
      now
    )
    if (record.parentTaskId) this.deps.cancelParentWakeup(record.parentTaskId, childTaskId)
    this.deps.appendTranscriptNote(childTaskId, 'Answered by the parent task.')
    subtaskEvents.emitSubtaskEvent({
      kind: 'child_question',
      parentTaskId: record.parentTaskId ?? childTaskId,
      childTaskId,
      questionId,
      needsAttention: false
    })

    return { success: true, record: this.deps.store.get(record.id)! }
  }

  /**
   * A human answers directly — through the dedicated UI (the banner), or
   * through the same claim-first path the existing generic
   * respond_to_checkpoint/send_message surfaces now use before falling
   * through to their original direct call. Works from EITHER
   * `pending_parent` or `escalated` (a human can always answer, whichever
   * state it's in) — unlike `answerFromParent`, which only works from
   * `pending_parent`.
   *
   * `questionId` is optional: when the caller doesn't have the harness's
   * exact pending-request id (the plain "answer a question via chat" case
   * has no such id), falls back to the single current live question for
   * that child. Returns `null` — not an error — when there's nothing live to
   * claim, so a generic caller can tell "nothing to do here" from "that
   * failed" and fall through to its own default behavior.
   */
  async answerAsHuman(
    childTaskId: string,
    questionId: string | undefined,
    input: { approved?: boolean; answer?: string; optionId?: string }
  ): Promise<AnswerChildQuestionResult | null> {
    const record = questionId
      ? this.deps.store.getByChildAndQuestionId(childTaskId, questionId)
      : this.deps.store.latestLiveForChild(childTaskId)
    // Not live at all (never existed, or already resolved/cancelled) — nothing
    // to do here, not an error; lets a generic caller fall through to its own
    // default behavior. A row that IS live but currently `answering` (someone
    // else's claim is in flight right now) falls through to the claim below,
    // which fails properly with an error instead of silently no-opping.
    if (!record || !isLiveChildQuestionState(record.state)) return null
    if (record.kind === 'approval' && typeof input.approved !== 'boolean') {
      return { error: 'approved (true or false) is required for an approval' }
    }

    const claimedAt = this.now()
    if (!this.deps.store.claim(record.id, claimedAt)) {
      return { error: 'That question was just answered another way' }
    }

    try {
      await this.deps.answerChildSession(
        childTaskId,
        record.kind,
        { approved: input.approved ?? false, answer: input.answer, optionId: input.optionId },
        record.questionId
      )
    } catch (err) {
      this.deps.store.revertClaim(record.id, this.now())
      return { error: err instanceof Error ? err.message : 'Failed to deliver the answer' }
    }

    const now = this.now()
    this.deps.store.updateState(
      record.id,
      { state: 'answered_by_human', answer: input.answer ?? null, optionId: input.optionId ?? null, answeredBy: 'human', answeredAt: now },
      now
    )
    if (record.parentTaskId) this.deps.cancelParentWakeup(record.parentTaskId, childTaskId)
    subtaskEvents.emitSubtaskEvent({
      kind: 'child_question',
      parentTaskId: record.parentTaskId ?? childTaskId,
      childTaskId,
      questionId: record.questionId,
      needsAttention: false
    })
    return { success: true, record: this.deps.store.get(record.id)! }
  }

  /** The parent explicitly hands a question to the human instead of answering it. */
  escalateToUser(callerTaskId: string, childTaskId: string, questionId: string, note?: string): AnswerChildQuestionResult {
    if (!this.deps.isDescendant(callerTaskId, childTaskId)) {
      return { error: 'That task is not a descendant of this task' }
    }
    const record = this.deps.store.getByChildAndQuestionId(childTaskId, questionId)
    if (!record) return { error: 'No such question for that task' }
    if (record.state !== 'pending_parent') {
      return { error: `That question is already "${record.state}"` }
    }

    const now = this.now()
    if (!this.deps.store.claimAndEscalate(record.id, note ?? null, now)) {
      return { error: 'That question was just answered another way' }
    }
    const updated = this.deps.store.get(record.id)!
    this.deps.notifyHuman(childTaskId, updated)
    subtaskEvents.emitSubtaskEvent({
      kind: 'child_question',
      parentTaskId: record.parentTaskId ?? childTaskId,
      childTaskId,
      questionId,
      needsAttention: true
    })
    return { success: true, record: updated }
  }

  /**
   * Periodic sweep: any question still `pending_parent` past its deadline —
   * because the parent never answered, or was never reachable at all — is
   * escalated to the human automatically.
   */
  sweepEscalations(): ChildQuestionRecord[] {
    const now = this.now()
    const due = this.deps.store.listPendingPastEscalateAt(now)
    const escalated: ChildQuestionRecord[] = []
    for (const record of due) {
      if (!this.deps.store.claimAndEscalate(record.id, null, now)) continue
      const updated = this.deps.store.get(record.id)!
      this.deps.notifyHuman(record.childTaskId, updated)
      subtaskEvents.emitSubtaskEvent({
        kind: 'child_question',
        parentTaskId: record.parentTaskId ?? record.childTaskId,
        childTaskId: record.childTaskId,
        questionId: record.questionId,
        needsAttention: true
      })
      escalated.push(updated)
    }
    return escalated
  }

  /**
   * The child's turn ended, its session stopped, or its task reached a
   * terminal state without the question ever being answered — whatever was
   * still live for it is moot now, not actionable by anyone. Marks it
   * `cancelled` rather than leaving it `pending_parent`/`escalated` forever
   * (which would otherwise keep `wait_for_subtasks`'s `any_event` returning
   * instantly on every call, and keep showing a stale item as if it still
   * needed an answer).
   */
  cancelLiveForChild(childTaskId: string, exceptQuestionId?: string): number {
    const now = this.now()
    const live = this.deps.store
      .listForChild(childTaskId)
      .filter((r) => isLiveChildQuestionState(r.state) && r.questionId !== exceptQuestionId)
    const cancelled = this.deps.store.cancelLive(childTaskId, now, exceptQuestionId)
    for (const record of live) {
      if (record.parentTaskId) this.deps.cancelParentWakeup(record.parentTaskId, childTaskId)
      subtaskEvents.emitSubtaskEvent({
        kind: 'child_question',
        parentTaskId: record.parentTaskId ?? childTaskId,
        childTaskId,
        questionId: record.questionId,
        needsAttention: false
      })
    }
    return cancelled
  }
}
