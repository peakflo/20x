/**
 * Maps control-plane transcript parts onto 20x `MessagePart`s.
 *
 * The wire shape was copied field for field from 20x's local transcript, so the
 * mapping is close to identity: `payload` carries `questions`, `todos`,
 * `taskProgress` and the rich `tool` detail that the 20x renderer expects on
 * `part.tool`.
 */

import { MessagePartType, type MessagePart } from '../adapters/coding-agent-adapter'
import { filterApprovalOptions } from '../../shared/enterprise-runners'
import type { WirePart } from './runner-api'

const PART_TYPES = new Set<string>(Object.values(MessagePartType))

const ANSWERED_STATUSES = new Set(['completed', 'cancelled', 'canceled', 'error', 'failed', 'denied', 'rejected', 'expired'])

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

export function mapPartType(partType: string): MessagePartType {
  return PART_TYPES.has(partType) ? (partType as MessagePartType) : MessagePartType.TEXT
}

export function wirePartToMessagePart(part: WirePart, opts: { update?: boolean } = {}): MessagePart {
  const payload = asRecord(part.payload)
  const richTool = asRecord(payload?.tool)
  const type = mapPartType(part.partType)
  const mapped: MessagePart = {
    id: part.partId,
    type,
    role: part.role,
    text: part.content,
    content: part.content,
    receivedAt: Date.parse(part.createdAt) || undefined,
    ...(opts.update ? { update: true } : {})
  }
  if (part.tool || richTool || payload?.questions || payload?.todos) {
    mapped.tool = {
      ...(richTool as Record<string, unknown> | undefined),
      name: part.tool ?? (typeof richTool?.name === 'string' ? richTool.name : 'tool'),
      requestId: part.partId,
      ...(payload?.questions !== undefined ? { questions: payload.questions } : {}),
      ...(payload?.todos !== undefined ? { todos: payload.todos } : {})
    }
  }
  if (payload?.taskProgress) mapped.taskProgress = payload.taskProgress as MessagePart['taskProgress']
  return mapped
}

export interface ApprovalOption {
  optionId: string
  name: string
  kind: 'allow_once' | 'reject_once'
}

export interface ParsedApproval {
  partId: string
  question: string
  options: ApprovalOption[]
  /** Unix ms the request was raised: the 30-minute clock starts here. */
  requestedAt: number
  answered: boolean
}

/** An approval request is a `permission` tool on a question part. */
export function isApprovalPart(part: WirePart): boolean {
  return part.partType === 'question' && part.tool === 'permission'
}

export function isQuestionPart(part: WirePart): boolean {
  return part.partType === 'question' && part.tool !== 'permission'
}

export function isAnswered(part: WirePart): boolean {
  const tool = asRecord(asRecord(part.payload)?.tool)
  const status = typeof tool?.status === 'string' ? tool.status : ''
  return ANSWERED_STATUSES.has(status) || (tool?.output !== undefined && tool.output !== null && tool.output !== '')
}

const REJECT = /reject|deny|no\b|decline|abort|cancel/i

/**
 * Allow / Reject only. Options come from the server; anything that looks like
 * "always allow" is dropped, and when the server sent none we offer exactly the
 * two canonical choices.
 */
export function parseApproval(part: WirePart): ParsedApproval | null {
  if (!isApprovalPart(part)) return null
  const payload = asRecord(part.payload)
  const questions = Array.isArray(payload?.questions) ? (payload!.questions as Array<Record<string, unknown>>) : []
  const rawOptions = Array.isArray(questions[0]?.options) ? (questions[0].options as Array<{ id?: string; label?: string }>) : []
  const offered = filterApprovalOptions(
    rawOptions.filter((o) => typeof o.label === 'string').map((o) => ({ id: o.id, label: o.label as string }))
  )
  let options: ApprovalOption[] = offered.map((o) => ({
    optionId: o.id ?? o.label,
    name: o.label,
    kind: REJECT.test(o.label) ? 'reject_once' : 'allow_once'
  }))
  if (options.length === 0) {
    options = [
      { optionId: 'approved', name: 'Allow', kind: 'allow_once' },
      { optionId: 'abort', name: 'Reject', kind: 'reject_once' }
    ]
  }
  const question = typeof questions[0]?.question === 'string' ? (questions[0].question as string) : part.content
  return {
    partId: part.partId,
    question,
    options,
    requestedAt: Date.parse(part.createdAt) || Date.now(),
    answered: isAnswered(part)
  }
}

export interface TurnUsage {
  tokens: number
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  credits: number | null
  model: string
}

/**
 * Reads the turn summary usage, when a part carries one. The summary is a
 * `turn_summary` / `usage` part whose payload has a `usage` object.
 */
export function extractTurnUsage(part: WirePart): TurnUsage | null {
  if (part.partType !== 'turn_summary' && part.partType !== 'usage' && part.tool !== 'turn_summary') return null
  const payload = asRecord(part.payload)
  const usage = asRecord(payload?.usage) ?? payload
  if (!usage) return null
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
  const input = num(usage.inputTokens ?? usage.input_tokens)
  const output = num(usage.outputTokens ?? usage.output_tokens)
  const total = num(usage.totalTokens ?? usage.total_tokens) || input + output
  const cost = usage.costUsd ?? usage.cost_usd
  const credits = usage.credits
  if (total === 0 && cost === undefined && credits === undefined) return null
  return {
    tokens: total,
    inputTokens: input,
    outputTokens: output,
    costUsd: typeof cost === 'number' ? cost : null,
    credits: typeof credits === 'number' ? credits : null,
    model: typeof usage.model === 'string' ? usage.model : 'runner'
  }
}
