/**
 * Turns a validated voice intent into a task action (design §5.5 and §5.6).
 *
 * Safety rules that this file enforces:
 *  - Only members of the closed `VoiceIntent` union run. Everything else is
 *    rejected before any database or agent call.
 *  - A task or an agent is never addressed by a fuzzy match without an explicit
 *    confirmation from the user.
 *  - Approve and reject always need a visible pending approval and a second
 *    confirmation. A mis-heard "reject" can therefore never approve.
 *  - The main process stays the only mutation writer. Each mutation emits one
 *    canonical event, which the desktop and the mobile clients both consume.
 */

import type { DatabaseManager, TaskRecord } from '../database'
import type { AgentManager } from '../agent-manager'
import {
  VOICE_CONFIRM_CONFIDENCE,
  VOICE_EVENTS,
  VOICE_MAX_CANDIDATES,
  VOICE_SETTING_KEYS,
  type VoiceActionOutcome,
  type VoiceCandidate,
  type VoiceConfirmReason,
  type VoiceIntent,
  type VoiceIntentProposal,
  type VoiceTargetRef,
  type VoiceUiContext,
} from '../../shared/voice'
import { isVoiceIntent } from '../../shared/voice-intent-parser'

/** The narrow slices of the managers this service is allowed to touch. */
export type VoiceActionDb = Pick<
  DatabaseManager,
  'getTasks' | 'getTask' | 'createTask' | 'updateTask' | 'getAgents' | 'getSetting'
>

export type VoiceActionAgents = Pick<
  AgentManager,
  'startTask' | 'sendByTaskId' | 'respondToPermission' | 'findSessionByTaskId' | 'getSessionStatus' | 'getLastAssistantMessage'
>

export interface VoiceActionDeps {
  db: VoiceActionDb
  agents: VoiceActionAgents
  /** Broadcasts one canonical event to the desktop renderer and mobile clients. */
  notify: (channel: string, data: unknown) => void
}

/**
 * `exact` covers an ID, the task on screen, and a full title match. `fuzzy`
 * covers a partial title match: it is usable, but design §5.6 forbids running a
 * task-changing action on it without a confirmation.
 */
type MatchQuality = 'exact' | 'fuzzy'

type Resolution<T> =
  | { ok: true; value: T; match: MatchQuality }
  | { ok: false; reason: 'not_found' | 'no_target' }
  | { ok: false; reason: 'ambiguous'; candidates: VoiceCandidate[] }

const ACTIVE_STATUSES = new Set(['triaging', 'agent_working', 'ready_for_review', 'agent_learning'])

export class VoiceActionService {
  constructor(private deps: VoiceActionDeps) {}

  /**
   * First pass over a proposal. Either asks for a confirmation or runs the
   * action. `confirmed` is set only by an explicit user confirmation.
   */
  async apply(
    turnId: string,
    proposal: VoiceIntentProposal,
    context: VoiceUiContext,
    confirmed = false
  ): Promise<VoiceActionOutcome> {
    if (!isVoiceIntent(proposal.intent)) {
      return { status: 'rejected', turnId, reason: 'unrecognized', message: 'That command is not supported.' }
    }

    const intent = proposal.intent
    if (intent.type === 'cancel') return { status: 'cancelled', turnId }

    // Resolve the target first: an ambiguous target must be settled before the
    // confirmation policy runs, so the user always sees what will change.
    const target = this.resolveTarget(intent, context)
    if (target && !target.ok) {
      if (target.reason === 'ambiguous') {
        return {
          status: 'needs_confirmation',
          turnId,
          proposal,
          candidates: target.candidates,
          reason: 'ambiguous_task',
        }
      }
      return {
        status: 'rejected',
        turnId,
        reason: target.reason,
        message:
          target.reason === 'no_target'
            ? 'Open a task first, or say the task name.'
            : 'No task with that name was found.',
      }
    }
    const task = target?.ok ? target.value : null
    const match = target?.ok ? target.match : 'exact'

    if (!confirmed) {
      const needed = this.confirmationReason(intent, proposal, task, match)
      if (needed) return { status: 'needs_confirmation', turnId, proposal, reason: needed }
    }

    try {
      return await this.execute(turnId, intent, context, task)
    } catch (err) {
      return {
        status: 'rejected',
        turnId,
        reason: 'failed',
        message: err instanceof Error ? err.message : 'The action failed.',
      }
    }
  }

  // ── Confirmation policy (design §5.5) ─────────────────────

  private confirmationReason(
    intent: VoiceIntent,
    proposal: VoiceIntentProposal,
    task: TaskRecord | null,
    match: MatchQuality
  ): VoiceConfirmReason | null {
    if (proposal.confidence < VOICE_CONFIRM_CONFIDENCE) return 'low_confidence'

    // A task-changing action never runs on a partial title match (design §5.6).
    if (
      match === 'fuzzy' &&
      (intent.type === 'assign_agent' ||
        intent.type === 'start_task' ||
        intent.type === 'approve_checkpoint' ||
        intent.type === 'reject_checkpoint')
    ) {
      return 'ambiguous_task'
    }

    switch (intent.type) {
      // Destructive or security-sensitive: always a second confirmation.
      case 'approve_checkpoint':
      case 'reject_checkpoint':
        return 'destructive'
      case 'create_task':
        return this.quickCreateEnabled() ? null : 'policy'
      case 'start_task':
        // Starting without an assigned agent can trigger triage, which can
        // change the scope of the task.
        return task && task.agent_id ? null : 'policy'
      case 'assign_agent': {
        const agent = this.resolveAgent(intent.agentName)
        return agent.ok ? null : 'ambiguous_agent'
      }
      default:
        return null
    }
  }

  private quickCreateEnabled(): boolean {
    return this.deps.db.getSetting(VOICE_SETTING_KEYS.quickCreate) === 'true'
  }

  // ── Execution ─────────────────────────────────────────────

  private async execute(
    turnId: string,
    intent: VoiceIntent,
    context: VoiceUiContext,
    task: TaskRecord | null
  ): Promise<VoiceActionOutcome> {
    switch (intent.type) {
      case 'create_task': {
        const created = this.deps.db.createTask({
          title: intent.title,
          description: intent.description ?? '',
          ...(intent.priority ? { priority: intent.priority } : {}),
        })
        if (!created) {
          return { status: 'rejected', turnId, reason: 'failed', message: 'The task was not created.' }
        }
        // One canonical event. The renderer store must not add the record itself.
        this.deps.notify('task:created', { task: created })
        return {
          status: 'executed',
          turnId,
          intent: intent.type,
          message: `Created “${created.title}”.`,
          taskId: created.id,
        }
      }

      case 'assign_agent': {
        if (!task) return this.noTarget(turnId)
        const agent = this.resolveAgent(intent.agentName)
        if (!agent.ok) {
          return agent.reason === 'ambiguous'
            ? {
                status: 'needs_confirmation',
                turnId,
                proposal: {
                  intent,
                  confidence: 1,
                  transcript: '',
                  source: 'deterministic',
                  summary: `Assign “${task.title}”`,
                },
                candidates: agent.candidates,
                reason: 'ambiguous_agent',
              }
            : { status: 'rejected', turnId, reason: 'not_found', message: 'No agent with that name was found.' }
        }
        const updated = this.deps.db.updateTask(task.id, { agent_id: agent.value.id })
        if (!updated) {
          return { status: 'rejected', turnId, reason: 'failed', message: 'The task was not updated.' }
        }
        this.deps.notify('task:updated', { taskId: task.id, updates: { agent_id: agent.value.id } })
        return {
          status: 'executed',
          turnId,
          intent: intent.type,
          message: `Assigned “${task.title}” to ${agent.value.name}.`,
          taskId: task.id,
        }
      }

      case 'start_task': {
        if (!task) return this.noTarget(turnId)
        const result = await this.deps.agents.startTask(task.id)
        const message =
          result.action === 'already_running'
            ? `“${task.title}” is already running.`
            : result.action === 'no_action'
              ? `“${task.title}” could not be started.`
              : `Started “${task.title}”.`
        return { status: 'executed', turnId, intent: intent.type, message, taskId: task.id }
      }

      case 'reply_to_agent': {
        if (!task) return this.noTarget(turnId)
        await this.deps.agents.sendByTaskId(task.id, intent.message)
        return {
          status: 'executed',
          turnId,
          intent: intent.type,
          message: `Sent to the agent on “${task.title}”.`,
          taskId: task.id,
        }
      }

      case 'approve_checkpoint':
      case 'reject_checkpoint': {
        const approved = intent.type === 'approve_checkpoint'
        const pending = this.validatePendingApproval(context, task)
        if (!pending) {
          return {
            status: 'rejected',
            turnId,
            reason: 'no_pending_approval',
            message: 'There is no checkpoint waiting for an answer.',
          }
        }
        await this.deps.agents.respondToPermission(pending.sessionId, approved, intent.message)
        return {
          status: 'executed',
          turnId,
          intent: intent.type,
          message: approved ? 'Checkpoint approved.' : 'Checkpoint rejected.',
          taskId: pending.taskId,
        }
      }

      case 'navigate': {
        this.deps.notify(VOICE_EVENTS.navigate, {
          destination: intent.destination,
          taskId: task?.id ?? context.selectedTaskId ?? null,
        })
        return {
          status: 'executed',
          turnId,
          intent: intent.type,
          message: `Opened ${intent.destination}.`,
          ...(task ? { taskId: task.id } : {}),
        }
      }

      case 'read_last_answer': {
        if (!task) return this.noTarget(turnId)
        const found = this.deps.agents.findSessionByTaskId(task.id)
        const text = found ? this.deps.agents.getLastAssistantMessage(found.sessionId) : null
        if (!text) {
          return { status: 'rejected', turnId, reason: 'not_found', message: 'There is no answer to read yet.' }
        }
        // Phase 1 shows the answer as text. Phase 2 sends it to the TTS worker.
        return { status: 'executed', turnId, intent: intent.type, message: text, taskId: task.id }
      }

      case 'cancel':
        return { status: 'cancelled', turnId }
    }
  }

  private noTarget(turnId: string): VoiceActionOutcome {
    return {
      status: 'rejected',
      turnId,
      reason: 'no_target',
      message: 'Open a task first, or say the task name.',
    }
  }

  /**
   * An approval runs only against the request that is on screen and that the
   * session still reports as waiting. A stale or unrelated session is refused.
   */
  private validatePendingApproval(
    context: VoiceUiContext,
    task: TaskRecord | null
  ): { taskId: string; sessionId: string } | null {
    const pending = context.pendingApproval
    if (!pending?.sessionId || !pending.taskId) return null
    if (task && task.id !== pending.taskId) return null
    const status = this.deps.agents.getSessionStatus(pending.sessionId)
    if (!status || status.status !== 'waiting_approval') return null
    if (status.taskId !== pending.taskId) return null
    return { taskId: pending.taskId, sessionId: pending.sessionId }
  }

  // ── Target resolution (design §5.6) ───────────────────────

  /** Returns null for intents that do not address a task. */
  private resolveTarget(intent: VoiceIntent, context: VoiceUiContext): Resolution<TaskRecord> | null {
    if (intent.type === 'create_task' || intent.type === 'cancel') return null
    if (intent.type === 'navigate' && !intent.taskRef) return null
    const ref = 'taskRef' in intent ? intent.taskRef : undefined
    if (!ref) return null
    return this.resolveTask(ref, context)
  }

  resolveTask(ref: VoiceTargetRef, context: VoiceUiContext): Resolution<TaskRecord> {
    // 1. An explicit ID.
    if (ref.kind === 'id') {
      const task = this.deps.db.getTask(ref.id)
      return task ? { ok: true, value: task, match: 'exact' } : { ok: false, reason: 'not_found' }
    }

    // 2. The task the user is looking at.
    if (ref.kind === 'current') {
      if (!context.selectedTaskId) return { ok: false, reason: 'no_target' }
      const task = this.deps.db.getTask(context.selectedTaskId)
      return task ? { ok: true, value: task, match: 'exact' } : { ok: false, reason: 'not_found' }
    }

    const spoken = ref.text.trim().toLowerCase()
    if (!spoken) return { ok: false, reason: 'not_found' }
    const tasks = this.deps.db.getTasks()

    // 3. One unique exact title.
    const exact = tasks.filter((t) => t.title.trim().toLowerCase() === spoken)
    if (exact.length === 1) return { ok: true, value: exact[0], match: 'exact' }
    if (exact.length > 1) return { ok: false, reason: 'ambiguous', candidates: taskCandidates(exact) }

    // 4. One unique partial title, active tasks ranked first.
    const partial = tasks.filter((t) => t.title.toLowerCase().includes(spoken))
    if (partial.length === 1) return { ok: true, value: partial[0], match: 'fuzzy' }
    if (partial.length === 0) return { ok: false, reason: 'not_found' }

    const active = partial.filter((t) => ACTIVE_STATUSES.has(t.status))
    if (active.length === 1) return { ok: true, value: active[0], match: 'fuzzy' }

    const ranked = [...partial].sort((a, b) => {
      const visible = (t: TaskRecord): number => (context.visibleTaskIds?.includes(t.id) ? 0 : 1)
      const activeRank = (t: TaskRecord): number => (ACTIVE_STATUSES.has(t.status) ? 0 : 1)
      return visible(a) - visible(b) || activeRank(a) - activeRank(b) || b.updated_at.localeCompare(a.updated_at)
    })
    // 5. Ask the user to pick.
    return { ok: false, reason: 'ambiguous', candidates: taskCandidates(ranked) }
  }

  resolveAgent(spokenName: string): Resolution<{ id: string; name: string }> {
    const spoken = spokenName.trim().toLowerCase().replace(/[.?!]$/, '')
    if (!spoken) return { ok: false, reason: 'not_found' }
    const agents = this.deps.db.getAgents()

    const exact = agents.filter((a) => a.name.trim().toLowerCase() === spoken)
    if (exact.length === 1) return { ok: true, value: { id: exact[0].id, name: exact[0].name }, match: 'exact' }
    if (exact.length > 1) return { ok: false, reason: 'ambiguous', candidates: agentCandidates(exact) }

    const partial = agents.filter((a) => a.name.toLowerCase().includes(spoken))
    if (partial.length === 1) return { ok: true, value: { id: partial[0].id, name: partial[0].name }, match: 'fuzzy' }
    if (partial.length === 0) return { ok: false, reason: 'not_found' }
    return { ok: false, reason: 'ambiguous', candidates: agentCandidates(partial) }
  }
}

function taskCandidates(tasks: TaskRecord[]): VoiceCandidate[] {
  return tasks.slice(0, VOICE_MAX_CANDIDATES).map((t) => ({ id: t.id, label: t.title, kind: 'task' as const }))
}

function agentCandidates(agents: Array<{ id: string; name: string }>): VoiceCandidate[] {
  return agents.slice(0, VOICE_MAX_CANDIDATES).map((a) => ({ id: a.id, label: a.name, kind: 'agent' as const }))
}
