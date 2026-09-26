/**
 * Peakflo AI subscription usage. Tolerant parser: accepts the dedicated
 * `/api/20x/ai-gateway/usage` payload and the older `/plan` payload
 * (spend / max budget). Returns null when there is no active subscription.
 */
export interface AiUsage {
  percent: number
  used: number | null
  limit: number | null
  resetAt: string | null
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

const pick = (o: Record<string, unknown>, keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]
  return undefined
}

export function parseAiUsage(payload: unknown): AiUsage | null {
  if (!payload || typeof payload !== 'object') return null
  const root = payload as Record<string, unknown>
  const nested = [root.usage, root.currentSubscription].find((v) => v && typeof v === 'object') as
    | Record<string, unknown>
    | undefined
  const src: Record<string, unknown> = { ...root, ...(nested ?? {}) }

  if (src.hasSubscription === false || src.subscribed === false) return null
  const status = src.status ?? (root.currentSubscription as Record<string, unknown> | undefined)?.status
  if (typeof status === 'string' && status !== 'active') return null
  if (!nested && src.percentUsed === undefined && src.percent === undefined && src.spend === undefined) return null

  const used = num(pick(src, ['used', 'spend', 'usedAmount', 'currentSpend']))
  const limit = num(pick(src, ['limit', 'maxBudget', 'max_budget', 'budget']))
  let percent = num(pick(src, ['percentUsed', 'percent', 'usagePercent']))
  if (percent === null) {
    if (used === null || limit === null || limit <= 0) return null
    percent = (used / limit) * 100
  }
  const reset = pick(src, ['resetAt', 'resetsAt', 'budgetResetAt', 'currentPeriodEnd'])
  return {
    percent: Math.min(100, Math.max(0, Math.round(percent))),
    used,
    limit,
    resetAt: typeof reset === 'string' ? reset : null
  }
}

export type UsageLevel = 'normal' | 'warn' | 'critical'
export const usageLevel = (percent: number): UsageLevel =>
  percent >= 95 ? 'critical' : percent >= 80 ? 'warn' : 'normal'

export async function fetchAiUsage(
  request: (method: string, path: string) => Promise<unknown>
): Promise<AiUsage | null> {
  for (const path of ['/api/20x/ai-gateway/usage', '/api/20x/ai-gateway/plan']) {
    try {
      const usage = parseAiUsage(await request('GET', path))
      if (usage) return usage
    } catch {
      // try next endpoint
    }
  }
  return null
}
