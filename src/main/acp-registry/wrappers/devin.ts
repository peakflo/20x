/**
 * Wrapper hooks for the "devin" registry agent.
 *
 * Illustrative, best-effort example of the wrapper mechanism: Devin's
 * published ACP wrapper reports its own HTTP-style status through turn
 * failures (a 429, or a message mentioning rate limiting), which the base
 * ACP protocol has no standard way to flag as "usage limit" rather than a
 * generic provider error. This hook pattern-matches on that text so a rate
 * limit surfaces uniformly to 20x's existing usage-limit stop/recovery flow
 * instead of as a hard failure.
 *
 * The exact error shape should be re-verified against a live session before
 * relying on this for anything beyond a reasonable default; the match is
 * intentionally conservative (only on explicit rate-limit wording) so it
 * never misclassifies an unrelated failure.
 */

import type { AcpWrapperHooks } from '../wrapper-hooks'

function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message)
  return String(error)
}

export const devinHooks: AcpWrapperHooks = {
  classifyError(error) {
    const text = errorText(error).toLowerCase()
    if (text.includes('429') || text.includes('rate limit') || text.includes('too many requests')) {
      return 'rate-limit'
    }
    if (text.includes('usage limit') || text.includes('quota exceeded')) {
      return 'usage-limit'
    }
    return undefined
  },

  preferredAuthMethod({ availableMethods, hasEnvVar }) {
    if (hasEnvVar('DEVIN_API_KEY') && availableMethods.includes('env_var')) return 'env_var'
    return availableMethods[0]
  }
}
