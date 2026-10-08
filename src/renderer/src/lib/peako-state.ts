import type { AgentMessage } from '@/stores/agent-store'
import { isSnoozed } from '@/lib/utils'
import {
  MASTERMIND_SESSION_ID,
  type PeakoChatMessage,
  type PeakoMood,
  type PeakoTaskGroup,
  type PeakoTaskItem
} from '@shared/peako'

export const PEAKO_SESSION_ID = MASTERMIND_SESSION_ID
/** How long with nothing happening before Peako dozes off. */
export const PEAKO_SLEEP_AFTER_MS = 30 * 60 * 1000
/** How long Peako celebrates a finished task. */
export const PEAKO_PARTY_MS = 6000
const MAX_MESSAGES = 40
const MAX_TEXT = 4000
const MAX_SCANNED_PARTS = 300
/** Tool states after which a question can no longer be answered. */
const CLOSED_TOOL_STATES = new Set(['completed', 'cancelled', 'error'])

export interface PeakoMoodInput {
  listening: boolean
  speaking: boolean
  /** Mastermind is answering, or a message is on its way to it. */
  thinking: boolean
  /** Any session, Mastermind or a task, waits for the user. */
  waiting: number
  working: number
  failed: number
  celebrating: boolean
  idleForMs: number
}

/** Picks the one mood that matters most right now. */
export function derivePeakoMood(input: PeakoMoodInput): PeakoMood {
  if (input.listening) return 'listening'
  if (input.waiting > 0) return 'needs'
  if (input.speaking) return 'speaking'
  if (input.thinking) return 'thinking'
  if (input.celebrating) return 'party'
  if (input.failed > 0) return 'stuck'
  if (input.working > 0) return 'working'
  if (input.idleForMs >= PEAKO_SLEEP_AFTER_MS) return 'sleep'
  return 'idle'
}

interface SessionLike {
  taskId: string
  status: string
  pendingApproval: unknown
}

/** The most tasks Peako lists; the rest are a click away in 20x. */
export const PEAKO_MAX_TASKS = 80

interface TaskLike {
  id: string
  title: string
  status: string
  agent_id: string | null
  snoozed_until?: string | null
}

const GROUP_ORDER: PeakoTaskGroup[] = ['needs', 'running', 'review', 'next']

/**
 * Where a task belongs in Peako's list, or null when it is not open work:
 * finished, or snoozed until later.
 */
export function peakoTaskGroup(task: TaskLike, session: SessionLike | undefined): PeakoTaskGroup | null {
  if (task.status === 'completed') return null
  if (session?.pendingApproval || session?.status === 'waiting_approval') return 'needs'
  if (session?.status === 'working') return 'running'
  if (task.status === 'agent_working' || task.status === 'triaging' || task.status === 'agent_learning') return 'running'
  if (task.status === 'ready_for_review') return 'review'
  if (isSnoozed(task.snoozed_until ?? null)) return null
  return 'next'
}

/** Open tasks, most urgent group first, keeping the user's own order inside a group. */
export function toPeakoTasks(
  tasks: TaskLike[],
  sessions: ReadonlyMap<string, SessionLike>,
  agentNames: ReadonlyMap<string, string>
): PeakoTaskItem[] {
  const byGroup = new Map<PeakoTaskGroup, PeakoTaskItem[]>(GROUP_ORDER.map((group) => [group, []]))
  for (const task of tasks) {
    const group = peakoTaskGroup(task, sessions.get(task.id))
    if (!group) continue
    byGroup.get(group)!.push({
      id: task.id,
      title: task.title.trim() || 'Untitled task',
      group,
      agentName: task.agent_id ? (agentNames.get(task.agent_id) ?? null) : null
    })
  }
  return GROUP_ORDER.flatMap((group) => byGroup.get(group)!).slice(0, PEAKO_MAX_TASKS)
}

/**
 * The question an agent is still waiting on, if any: the last question in the
 * transcript with no user message after it. A reply then answers it instead
 * of arriving as a new message the agent is not listening for.
 */
export function findOpenQuestion(messages: AgentMessage[]): AgentMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'user') return null
    if (message.partType === 'question' && message.tool?.questions?.length) {
      return CLOSED_TOOL_STATES.has(message.tool.status) ? null : message
    }
  }
  return null
}

/** Counts task sessions by state. Mastermind's own session is left out. */
export function countSessions(sessions: Iterable<SessionLike>): { working: number; waiting: number; failed: number } {
  const counts = { working: 0, waiting: 0, failed: 0 }
  for (const session of sessions) {
    if (session.taskId === PEAKO_SESSION_ID) continue
    if (session.pendingApproval || session.status === 'waiting_approval') counts.waiting++
    else if (session.status === 'working') counts.working++
    else if (session.status === 'error') counts.failed++
  }
  return counts
}

function clip(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT)}…` : trimmed
}

/**
 * Turns the Mastermind transcript into the short chat Peako shows: what was
 * said, one line per tool, and any question with its choices. Reasoning,
 * step markers and status parts stay in the full transcript in the app.
 */
export function toPeakoMessages(messages: AgentMessage[]): PeakoChatMessage[] {
  const out: PeakoChatMessage[] = []
  // Only the tail can reach the 40 shown, so a long transcript costs the same as a short one.
  for (const message of messages.slice(-MAX_SCANNED_PARTS)) {
    const partType = message.partType ?? 'text'
    if (message.role === 'user') {
      if (message.content.trim()) out.push({ id: message.id, role: 'user', text: clip(message.content) })
      continue
    }
    if (partType === 'question' && message.tool?.questions?.length) {
      const question = message.tool.questions[0]
      const open = !CLOSED_TOOL_STATES.has(message.tool.status)
      out.push({
        id: message.id,
        role: 'question',
        text: clip(question.question || question.header || message.content),
        options: open ? question.options.map((option) => option.label).filter(Boolean).slice(0, 6) : undefined
      })
      continue
    }
    if (partType === 'tool' && message.tool) {
      const text = message.tool.title || message.tool.name
      const previous = out[out.length - 1]
      // A run of tool calls reads as one line that updates in place.
      if (previous?.role === 'tool') previous.text = text
      else out.push({ id: message.id, role: 'tool', text })
      continue
    }
    if ((partType === 'text' || partType === 'error') && message.role === 'assistant' && message.content.trim()) {
      out.push({ id: message.id, role: 'assistant', text: clip(message.content) })
    }
  }
  return out.slice(-MAX_MESSAGES)
}

/** Reads the model an agent runs, for the picker label. */
export function agentModelLabel(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null
  const model = (config as Record<string, unknown>).model
  return typeof model === 'string' && model.trim() ? model.trim() : null
}
