/**
 * Per-agent view of subscription plan limits, for agents that pick other
 * agents (triage, coordinators). Agent fit always comes first; this summary
 * lets them break ties in favour of the harness with the most headroom.
 */

import type { ProviderUsageLimits } from '../../shared/usage'
import { effectiveUsedPercent, isUsageProvider } from '../../shared/usage'

/**
 * - `low` (< 50% used), `moderate` (< 75%), `high` (< 90%), `critical` (≥ 90%),
 * - `exhausted`: a limit is currently blocking requests,
 * - `unknown`: no reading yet / the harness does not report plan limits,
 * - `not_applicable`: API-key sign-in, plan limits do not apply.
 */
export type AgentUsageLevel = 'low' | 'moderate' | 'high' | 'critical' | 'exhausted' | 'unknown' | 'not_applicable'

export interface AgentUsageSummary {
  level: AgentUsageLevel
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
}

function levelFor(usedPercent: number): AgentUsageLevel {
  if (usedPercent >= 90) return 'critical'
  if (usedPercent >= 75) return 'high'
  if (usedPercent >= 50) return 'moderate'
  return 'low'
}

export function summarizeAgentUsage(
  agent: AgentLike,
  limitsByProvider: Map<string, ProviderUsageLimits>,
  nowMs = Date.now()
): AgentUsageSummary {
  const empty = { most_used_percent: null, headroom_percent: null, windows: [], plan_type: null, checked_at: null }
  const provider = agent.config?.coding_agent
  if (agent.config?.auth_method === 'api_key') {
    return { level: 'not_applicable', ...empty, note: 'API key sign-in: subscription plan limits do not apply.' }
  }
  if (!isUsageProvider(provider)) {
    return { level: 'unknown', ...empty, note: 'Harness does not report plan limits.' }
  }
  const limits = limitsByProvider.get(provider)
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
    label: window.label,
    used_percent: Math.round(effectiveUsedPercent(window, nowMs)),
    resets_at: window.resetsAt ?? null
  }))
  const mostUsed = Math.max(...windows.map((window) => window.used_percent))
  const exhausted = limits.limitReached === true || mostUsed >= 100
  const level = exhausted ? 'exhausted' : levelFor(mostUsed)
  const busiest = windows.find((window) => window.used_percent === mostUsed)!
  return {
    level,
    most_used_percent: mostUsed,
    headroom_percent: Math.max(0, 100 - mostUsed),
    windows,
    plan_type: limits.planType ?? null,
    checked_at: limits.checkedAt,
    note: exhausted
      ? `Limit reached${busiest.resets_at ? `; resets ${busiest.resets_at}` : ''}. Avoid unless it is the only suitable agent.`
      : `${mostUsed}% of the ${busiest.label.toLowerCase()} window used.`
  }
}

/** Indexes plan-limit snapshots by provider id. */
export function limitsByProvider(limits: ProviderUsageLimits[]): Map<string, ProviderUsageLimits> {
  return new Map(limits.map((snapshot) => [snapshot.provider, snapshot]))
}
