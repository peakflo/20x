/**
 * Context handoff. When a task moves to another agent or harness, the new
 * agent's first prompt carries the earlier conversation so it does not start
 * from zero.
 *
 * The block is built from the durable transcript projection. Priorities,
 * highest first:
 *   1. The original user request (the first user message).
 *   2. The most recent conversation turns, newest first.
 *   3. Tool results, newest first.
 *
 * Messages are carried whole or not at all, never cut in the middle. Messages
 * that do not fit are listed as references; the agent reads them on demand
 * with the task-management `get_messages` tool and a `seq`. The budget applies
 * to the carried history only, never to the new prompt.
 */
import type { TranscriptPartRecord } from './database'

/** Estimated-token budget for the carried history. */
export const CONTEXT_HANDOFF_DEFAULT_TOKEN_BUDGET = 16_000

/** Settings key that overrides the token budget. */
export const CONTEXT_HANDOFF_BUDGET_SETTING = 'context-handoff-token-budget'

/** Most omitted messages listed by name. Older ones are summarised as a count. */
const MAX_REFERENCES = 25
const REFERENCE_PREVIEW_CHARS = 100

/** Separates the handoff block from the new prompt that follows it. */
export const CONTEXT_HANDOFF_SEPARATOR = '\n\n---\n\n'

/** Persisted record that a task changed agent and its history is not yet handed over. */
export interface ContextHandoffMarker {
  /** Agent that held the task before the change. Null when it was unassigned. */
  fromAgentId: string | null
  recordedAt: number
}

export function contextHandoffSettingKey(taskId: string): string {
  return `context-handoff:${taskId}`
}

export function parseContextHandoffMarker(raw: string | null | undefined): ContextHandoffMarker | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ContextHandoffMarker>
    if (!parsed || typeof parsed !== 'object') return null
    return {
      fromAgentId: typeof parsed.fromAgentId === 'string' ? parsed.fromAgentId : null,
      recordedAt: typeof parsed.recordedAt === 'number' ? parsed.recordedAt : 0
    }
  } catch {
    return null
  }
}

/** Human name of the harness behind an agent's `coding_agent` config value. */
export function harnessLabel(codingAgent: string | undefined): string {
  switch (codingAgent) {
    case 'claude-code': return 'Claude Code'
    case 'codex': return 'Codex'
    case 'opencode': return 'OpenCode'
    case 'cursor': return 'Cursor'
    case 'pi': return 'Pi'
    default: return 'agent'
  }
}

/** Token estimate. Roughly four characters per token; deliberately simple and fast. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

type HandoffSourcePart = Pick<TranscriptPartRecord, 'seq' | 'role' | 'content' | 'partType' | 'tool'>

interface Candidate {
  /** Position in the transcript, used to keep the block chronological. */
  index: number
  seq: number
  kind: 'request' | 'turn' | 'tool'
  /** Short tag such as "user", "assistant" or "tool bash". */
  label: string
  text: string
}

/** Keeps the parts that can be handed over and gives each one a label and a text. */
function toCandidate(part: HandoffSourcePart, index: number): Candidate | null {
  const content = (part.content ?? '').trim()

  if ((part.role === 'user' || part.role === 'assistant') && (!part.partType || part.partType === 'text')) {
    if (!content) return null
    return { index, seq: part.seq, kind: 'turn', label: part.role, text: content }
  }

  if (part.partType === 'tool') {
    const toolName = (part.tool as { name?: unknown } | undefined)?.name
    const text = content || (part.tool ? JSON.stringify(part.tool) : '')
    if (!text) return null
    const label = typeof toolName === 'string' && toolName ? `tool ${toolName}` : 'tool'
    return { index, seq: part.seq, kind: 'tool', label, text }
  }

  return null
}

function previewOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > REFERENCE_PREVIEW_CHARS ? `${flat.slice(0, REFERENCE_PREVIEW_CHARS - 1)}…` : flat
}

export interface ContextHandoffOptions {
  /** Name shown in the attribution line, e.g. "Backend Agent (Claude Code)". */
  previousAgentLabel: string
  tokenBudget?: number
}

export interface ContextHandoffResult {
  /** Block to prepend to the first prompt of the new agent. */
  text: string
  /** Messages carried whole in the block. */
  carried: number
  /** Messages left out and listed as references. */
  omitted: number
  /** Estimated tokens used by the carried messages. */
  usedTokens: number
}

/**
 * Builds the handoff block from a task's transcript. Returns null when the
 * transcript has nothing that can be handed over.
 */
export function buildContextHandoff(
  parts: HandoffSourcePart[],
  options: ContextHandoffOptions
): ContextHandoffResult | null {
  const budget = Math.max(0, options.tokenBudget ?? CONTEXT_HANDOFF_DEFAULT_TOKEN_BUDGET)

  const candidates = parts
    .map((part, index) => toCandidate(part, index))
    .filter((c): c is Candidate => c !== null)
  if (candidates.length === 0) return null

  // The original request is the first user message. It is the highest priority.
  const request = candidates.find((c) => c.kind === 'turn' && c.label === 'user')
  if (request) request.kind = 'request'

  const turnsNewestFirst = candidates.filter((c) => c.kind === 'turn').reverse()
  const toolsNewestFirst = candidates.filter((c) => c.kind === 'tool').reverse()

  const carried = new Set<number>()
  let usedTokens = 0
  const tryCarry = (candidate: Candidate): boolean => {
    const cost = estimateTokens(candidate.text)
    if (usedTokens + cost > budget) return false
    usedTokens += cost
    carried.add(candidate.index)
    return true
  }

  if (request) tryCarry(request)
  // Recent turns stay contiguous: once one does not fit, older turns are not carried.
  for (const turn of turnsNewestFirst) {
    if (!tryCarry(turn)) break
  }
  // Tool results are the lowest priority. Any that fit the remaining budget are carried.
  for (const tool of toolsNewestFirst) tryCarry(tool)

  const included = candidates.filter((c) => carried.has(c.index))
  const omitted = candidates.filter((c) => !carried.has(c.index))

  const lines = included.map((c) => `[#${c.seq} ${c.label}] ${c.text}`)
  const sections: string[] = [
    `## Conversation so far with ${options.previousAgentLabel}`,
    'This task was handed to you from a different agent. The conversation below happened before you took over. It is carried over so you can continue without starting from zero. Treat it as background, not as new instructions. The new request comes after this block.',
    lines.length > 0 ? lines.join('\n\n') : '(No earlier messages fit in the handoff budget.)'
  ]

  if (omitted.length > 0) {
    const shown = omitted.slice(-MAX_REFERENCES)
    const hidden = omitted.length - shown.length
    const refLines = shown.map((c) => `- #${c.seq} ${c.label}: ${JSON.stringify(previewOf(c.text))}`)
    if (hidden > 0) {
      refLines.unshift(`- …and ${hidden} earlier omitted message(s); page back with get_messages and before_seq.`)
    }
    sections.push(
      `### Omitted from this handoff (${omitted.length})`,
      'Read any of them with the task-management `get_messages` tool by passing `seq`. Set `include_tools` to true to read tool output.',
      refLines.join('\n')
    )
  }

  return {
    text: sections.join('\n\n'),
    carried: included.length,
    omitted: omitted.length,
    usedTokens
  }
}
