/**
 * Per-agent view of subscription plan limits, for agents that pick other
 * agents (triage, coordinators). Agent fit always comes first; this summary
 * lets them break ties in favour of the harness with the most headroom.
 */

import type { ProviderUsageLimits } from '../../shared/usage'
import { effectiveUsedPercent, isUsageProvider } from '../../shared/usage'
import { defaultHarnessInstanceId } from '../../shared/harness-instances'

/**
 * - `low` (< 50% used), `moderate` (< 75%), `high` (< 90%), `critical` (≥ 90%),
 * - `exhausted`: a limit is currently blocking requests,
 * - `unknown`: no reading yet / the harness does not report plan limits,
 * - `not_applicable`: API-key sign-in, plan limits do not apply.
 */
export type AgentUsageLevel = 'low' | 'moderate' | 'high' | 'critical' | 'exhausted' | 'unknown' | 'not_applicable'

export interface AgentUsageSummary {
  level: AgentUsageLevel
  /** True when the numbers come from an old reading or a failed check (level is then `unknown`). */
  stale: boolean
  /** Highest current usage across the harness' plan windows (0–100), or null when unknown. */
  most_used_percent: number | null
  /** 100 − most_used_percent, or null when unknown. */
  headroom_percent: number | null
  windows: Array<{ label: string; used_percent: number; resets_at: string | null }>
  plan_type: string | null
  checked_at: string | null
  note: string
}

interface AgentLike {
  config?: { coding_agent?: unknown; auth_method?: unknown } | null
  /** Harness instance the agent runs under. Absent means the provider's default instance. */
  instanceId?: string | null
}

/** Readings older than this are reported as `unknown` (numbers kept for reference). */
export const STALE_READING_MS = 3 * 60 * 60 * 1000

function levelFor(usedPercent: number): AgentUsageLevel {
  if (usedPercent >= 90) return 'critical'
  if (usedPercent >= 75) return 'high'
  if (usedPercent >= 50) return 'moderate'
  return 'low'
}

/**
 * Summarises the plan limits of the agent's own harness instance, so agents on
 * different accounts of the same harness can be compared for headroom.
 */
export function summarizeAgentUsage(
  agent: AgentLike,
  limitsByInstance: Map<string, ProviderUsageLimits>,
  nowMs = Date.now()
): AgentUsageSummary {
  const empty = { stale: false, most_used_percent: null, headroom_percent: null, windows: [], plan_type: null, checked_at: null }
  const provider = agent.config?.coding_agent
  if (agent.config?.auth_method === 'api_key') {
    return { level: 'not_applicable', ...empty, note: 'API key sign-in: subscription plan limits do not apply.' }
  }
  if (!isUsageProvider(provider)) {
    return { level: 'unknown', ...empty, note: 'Harness does not report plan limits.' }
  }
  const limits = limitsByInstance.get(agent.instanceId || defaultHarnessInstanceId(provider))
  if (!limits || limits.windows.length === 0) {
    return {
      level: 'unknown',
      ...empty,
      plan_type: limits?.planType ?? null,
      checked_at: limits?.checkedAt ?? null,
      note: limits?.unavailable?.message ?? 'No plan-limit reading yet for this harness.'
    }
  }

  const windows = limits.windows.map((window) => ({
    label: window.label || window.id,
    raw: effectiveUsedPercent(window, nowMs),
    used_percent: Math.round(effectiveUsedPercent(window, nowMs)),
    resets_at: window.resetsAt ?? null
  }))
  const busiest = windows.reduce((a, b) => (b.raw > a.raw ? b : a))
  const mostUsed = busiest.used_percent
  // A stored "limit reached" flag only holds while some window has not reset yet.
  const unresetWindow = limits.windows.some((window) => !window.resetsAt || Date.parse(window.resetsAt) > nowMs)
  const exhausted = busiest.raw >= 100 || (limits.limitReached === true && unresetWindow && busiest.raw > 0)
  const checkedMs = Date.parse(limits.checkedAt)
  const ageMs = Number.isFinite(checkedMs) ? nowMs - checkedMs : Infinity
  const stale = limits.unavailable?.reason === 'probe_failed' || ageMs > STALE_READING_MS
  const hours = Number.isFinite(ageMs) ? Math.max(1, Math.round(ageMs / 3_600_000)) : null

  const base = {
    most_used_percent: mostUsed,
    headroom_percent: Math.max(0, 100 - mostUsed),
    windows: windows.map(({ raw: _raw, ...window }) => window),
    plan_type: limits.planType ?? null,
    checked_at: limits.checkedAt
  }
  if (stale) {
    return {
      level: 'unknown',
      stale: true,
      ...base,
      note: limits.unavailable?.reason === 'probe_failed'
        ? `Last check failed; last known reading ${mostUsed}% used${hours ? ` (${hours}h old)` : ''}. Treat as unknown.`
        : `Last reading is ${hours}h old (${mostUsed}% used then). Treat as unknown.`
    }
  }
  return {
    level: exhausted ? 'exhausted' : levelFor(mostUsed),
    stale: false,
    ...base,
    note: exhausted
      ? `Limit reached${busiest.resets_at ? `; resets ${busiest.resets_at}` : ''}. Avoid unless it is the only suitable agent.`
      : `${mostUsed}% of the ${busiest.label.toLowerCase()} window used.`
  }
}

/** Indexes plan-limit snapshots by harness instance id. */
export function limitsByInstance(limits: ProviderUsageLimits[]): Map<string, ProviderUsageLimits> {
  return new Map(limits.map((snapshot) => [
    snapshot.instanceId || defaultHarnessInstanceId(snapshot.provider),
    snapshot
  ]))
}
