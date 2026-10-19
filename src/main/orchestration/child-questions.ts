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
 * 1. No parent, parent completed, the "route to parent" setting is off, the
 *    parent's own `permission_mode` is `ask` (it has no standing authority to
 *    grant), or the question needs an operation the authority gate reserves
 *    for a human (deploys, merges, destructive commands, payments, external
 *    messages) → straight to the human (today's push/OS notification), with
 *    the parent still told, for information.
 * 2. Otherwise → a durable, deduplicated wake-up to the parent (reusing
 *    `task_wakeups`/`TaskWakeupQueue` — reason `child_question`), with an
 *    escalation deadline. If the parent hasn't answered by then (or was never
 *    reachable), an idle sweep escalates to the human automatically.
 *
 * The parent answers through `answerFromParent`, which drives the exact same
 * adapter call the human UI's `respond_to_checkpoint`/`send_message` use —
 * so every harness (Claude Code, Codex, OpenCode, Pi, ACP) is answered the
 * same way regardless of who answered. A human who answers directly (through
 * the existing path) cancels the parent's pending item via
 * `cancelLatestPendingForChild`.
 */

import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { evaluateAuthorityGate } from '../../shared/system-authority'
import { subtaskEvents } from './subtask-events'
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

  /** Rows still waiting on the parent whose deadline has passed — the automatic-escalation sweep's input. */
  listPendingPastEscalateAt(nowMs: number): ChildQuestionRecord[] {
    return (
      this.db
        .prepare(`SELECT * FROM child_questions WHERE state = 'pending_parent' AND escalate_at IS NOT NULL AND escalate_at <= ?`)
        .all(nowMs) as ChildQuestionRow[]
    ).map(fromRow)
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
  /** Drives the same adapter call the human UI's respond_to_checkpoint/send_message use. */
  answerChildSession: (
    childTaskId: string,
    kind: ChildQuestionKind,
    input: { approved: boolean; answer?: string; optionId?: string }
  ) => Promise<void>
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
   * Raises a question/approval for one child session. Idempotent: raising
   * the same (childTaskId, questionId) twice returns the original record
   * instead of creating a second one or re-notifying anybody.
   */
  async raise(input: RaiseChildQuestionInput): Promise<ChildQuestionRecord | null> {
    const existing = this.deps.store.getByChildAndQuestionId(input.childTaskId, input.questionId)
    if (existing) return existing

    const childTask = this.deps.getTask(input.childTaskId)
    if (!childTask) return null

    const parentTaskId = childTask.parent_task_id
    const parentTask = parentTaskId ? this.deps.getTask(parentTaskId) : undefined
    const policy = parentTaskId ? this.deps.getParentPolicy(parentTaskId) : {}

    const authoritySourceText = [input.toolName, input.command, input.questionText].filter(Boolean).join(' ')
    const authority = evaluateAuthorityGate(scrubSecretsForExcerpt(authoritySourceText, 4000))
    const contextExcerpt = scrubSecretsForExcerpt(input.contextExcerpt ?? authoritySourceText)

    // A parent under its own `ask` permission mode has no standing authority
    // of its own to grant — it must ask a human for everything, so it cannot
    // grant a child more than that either.
    const parentUnderAskMode = policy.permissionMode === 'ask'
    const routeToParent = policy.routeToParent ?? true
    const parentReachable = !!parentTaskId && !!parentTask && parentTask.status !== 'completed'

    const mustEscalate =
      !parentReachable || !routeToParent || parentUnderAskMode || authority.requiresHumanAuthorization

    const now = this.now()
    const timeoutMs = policy.escalationTimeoutMs ?? DEFAULT_CHILD_QUESTION_ESCALATION_TIMEOUT_MS

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
        requiresHuman: authority.requiresHumanAuthorization,
        authorityCategories: authority.categories,
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

    await this.deps.answerChildSession(childTaskId, record.kind, {
      approved: input.approved ?? true,
      answer: input.answer,
      optionId: input.optionId
    })

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
    this.deps.store.updateState(record.id, { state: 'escalated', note: note ?? null, escalatedAt: now }, now)
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
      this.deps.store.updateState(record.id, { state: 'escalated', escalatedAt: now }, now)
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
   * A human answered directly, through the existing respond_to_checkpoint /
   * send_message path. Cancels the parent's pending item (if any) so it
   * isn't nudged about a question that's already settled, and shows
   * "Answered by you" instead of leaving it looking unresolved.
   */
  cancelLatestPendingForChild(childTaskId: string, answerSummary?: string): ChildQuestionRecord | null {
    const candidates = this.deps.store
      .listForChild(childTaskId)
      .filter((r) => r.state === 'pending_parent' || r.state === 'escalated')
    if (candidates.length === 0) return null
    const latest = candidates.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b))

    const now = this.now()
    this.deps.store.updateState(
      latest.id,
      { state: 'answered_by_human', answer: answerSummary ?? null, answeredBy: 'human', answeredAt: now },
      now
    )
    if (latest.parentTaskId) this.deps.cancelParentWakeup(latest.parentTaskId, childTaskId)
    subtaskEvents.emitSubtaskEvent({
      kind: 'child_question',
      parentTaskId: latest.parentTaskId ?? childTaskId,
      childTaskId,
      questionId: latest.questionId,
      needsAttention: false
    })
    return this.deps.store.get(latest.id)
  }
}
