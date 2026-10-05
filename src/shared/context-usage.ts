/**
 * Agent context-window meter — types and pure helpers shared by the main
 * process, the desktop renderer and the mobile web app.
 *
 * Each coding-agent adapter reports how full the model's context window is for
 * its session (`ContextUsageReport`). The agent manager merges those partial
 * reports per task into a `ContextUsageSnapshot`, pushes it to clients as
 * `agent:context-usage`, and serves the latest one for hydration.
 */

/** Live push channel: main → renderer and mobile WebSocket clients. Payload: `ContextUsageSnapshot`. */
export const AGENT_CONTEXT_USAGE_CHANNEL = 'agent:context-usage'

/** Bounds for the Claude auto-compact threshold setting (tokens). */
export const AUTO_COMPACT_TOKENS_MIN = 100_000
export const AUTO_COMPACT_TOKENS_MAX = 1_000_000
/** Window of standard (non `[1m]`) models. */
export const AUTO_COMPACT_TOKENS_STANDARD_MAX = 200_000

/** Slash command that asks the harness to compact the conversation. */
export const COMPACT_COMMAND = '/compact'

/** Meter colour thresholds (percent of the window). */
export const CONTEXT_WARNING_PERCENT = 70
export const CONTEXT_CRITICAL_PERCENT = 90

/**
 * What an adapter knows at one moment. Every field is optional except that a
 * report is only useful when it says something: `null` / `undefined` means
 * "unchanged since the last report", so partial reports merge cleanly.
 */
export interface ContextUsageReport {
  /** Tokens currently occupying the context window. */
  usedTokens?: number | null
  /** The harness no longer knows how full the window is (e.g. compaction without a post-size). Clears `usedTokens`. */
  unknownUsage?: boolean
  /** Size of the context window the usage is measured against. */
  maxTokens?: number | null
  /** Model the window belongs to. */
  model?: string | null
  /** True while the harness is compacting the conversation history. */
  compacting?: boolean
  /** Whether the harness can compact on request (`/compact`). */
  canCompact?: boolean
}

/** An adapter report, attributed to the task / agent that owns the session. */
export interface AdapterContextUsageReport extends ContextUsageReport {
  taskId?: string
  agentId?: string
  /** Harness session / thread id the numbers belong to. */
  providerSessionId?: string
}

/** Latest known context state for one task. Sent to clients as `agent:context-usage`. */
export interface ContextUsageSnapshot {
  taskId: string
  agentId: string | null
  /** Coding-agent id of the session (`claude-code`, `codex`, ...), when known. */
  codingAgent: string | null
  usedTokens: number | null
  maxTokens: number | null
  /** `usedTokens / maxTokens` as a percentage, unclamped (may exceed 100). Null when either side is unknown. */
  percent: number | null
  model: string | null
  compacting: boolean
  canCompact: boolean
  updatedAt: string
}

export type ContextUsageLevel = 'normal' | 'warning' | 'critical'

/** Used / max as a percentage, or null when the window size is unknown or zero. */
export function contextUsagePercent(usedTokens: number | null | undefined, maxTokens: number | null | undefined): number | null {
  if (typeof usedTokens !== 'number' || !Number.isFinite(usedTokens) || usedTokens < 0) return null
  if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens) || maxTokens <= 0) return null
  return (usedTokens / maxTokens) * 100
}

export function contextUsageLevel(percent: number | null | undefined): ContextUsageLevel {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return 'normal'
  if (percent >= CONTEXT_CRITICAL_PERCENT) return 'critical'
  if (percent >= CONTEXT_WARNING_PERCENT) return 'warning'
  return 'normal'
}

/** Compact token count for the meter: 950, 12.3k, 200k, 1M, 1.5M. */
export function formatContextTokens(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const abs = Math.max(0, value)
  if (abs < 1_000) return String(Math.round(abs))
  if (abs < 100_000) return `${(abs / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  if (abs < 1_000_000) return `${Math.round(abs / 1_000)}k`
  const millions = abs / 1_000_000
  return `${millions.toFixed(millions < 10 ? 1 : 0).replace(/\.0$/, '')}M`
}

/** Largest window a model can use: 1M for `[1m]` variants, 200k otherwise. */
export function contextWindowCapForModel(model: string | null | undefined): number {
  return model && model.includes('[1m]') ? AUTO_COMPACT_TOKENS_MAX : AUTO_COMPACT_TOKENS_STANDARD_MAX
}

/**
 * Persisted auto-compact threshold: a whole number of tokens within bounds, or
 * null (off). When the model is known the value is also capped at that model's
 * real window, so a 200k model never gets a 1M threshold.
 */
export function normalizeAutoCompactTokens(value: unknown, model?: string | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.round(value / 1_000) * 1_000
  const cap = model ? Math.min(AUTO_COMPACT_TOKENS_MAX, contextWindowCapForModel(model)) : AUTO_COMPACT_TOKENS_MAX
  return Math.min(cap, Math.max(AUTO_COMPACT_TOKENS_MIN, rounded))
}

/** Harnesses that can compact on request (`/compact`). Other harnesses receive it as plain text. */
const COMPACT_CAPABLE_HARNESSES: ReadonlySet<string> = new Set(['claude-code', 'codex'])

export function harnessCanCompact(codingAgent: string | null | undefined): boolean {
  return !!codingAgent && COMPACT_CAPABLE_HARNESSES.has(codingAgent)
}

export function isCompactCommand(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.trim() === COMPACT_COMMAND
}

/**
 * Merges a report into the previous snapshot for the same task. Fields the
 * report leaves out keep their previous value; `percent` is always recomputed.
 */
export function mergeContextUsage(
  previous: ContextUsageSnapshot | undefined,
  report: ContextUsageReport,
  meta: { taskId: string; agentId?: string | null; codingAgent?: string | null; now?: string }
): ContextUsageSnapshot {
  const usedTokens = report.unknownUsage ? null : (report.usedTokens ?? previous?.usedTokens ?? null)
  const maxTokens = report.maxTokens ?? previous?.maxTokens ?? null
  return {
    taskId: meta.taskId,
    agentId: meta.agentId ?? previous?.agentId ?? null,
    codingAgent: meta.codingAgent ?? previous?.codingAgent ?? null,
    usedTokens,
    maxTokens,
    percent: contextUsagePercent(usedTokens, maxTokens),
    model: report.model ?? previous?.model ?? null,
    compacting: report.compacting ?? previous?.compacting ?? false,
    canCompact: report.canCompact ?? previous?.canCompact ?? false,
    updatedAt: meta.now ?? new Date().toISOString()
  }
}
