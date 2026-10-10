/**
 * Wrapper hooks for the "mistral-vibe" registry agent.
 *
 * Illustrative, best-effort example of a *notification*-based retry signal,
 * as opposed to devin's error-text classification (see `./devin.ts`). Some
 * ACP agents proactively push a custom JSON-RPC notification mid-turn —
 * outside the standard `session/update` stream — to announce that their
 * underlying model SDK is backing off and retrying, tagged with a small
 * cause enum. This hook listens for that one extension method and forwards
 * a rate-limited cause into the shared retry/usage-limit channel, and
 * everything else into the generic transport-retry bucket, so both still
 * reach the same downstream backoff machinery despite using a completely
 * different wire mechanism than devin's plain error text.
 *
 * The exact notification method name/payload shape here is a placeholder
 * pending verification against a live session — adjust `EXTENSION_METHOD`
 * and the cause field name to match what the real agent actually sends.
 */

import type { AcpWrapperHooks } from '../wrapper-hooks'

const EXTENSION_METHOD = 'mistralVibe/providerRetry'

interface ProviderRetryParams {
  cause?: 'rate_limited' | 'server_error' | 'timeout' | 'connection' | 'unknown'
}

export const mistralVibeHooks: AcpWrapperHooks = {
  handleExtensionNotification(method, params) {
    if (method !== EXTENSION_METHOD) return undefined
    const cause = (params as ProviderRetryParams | undefined)?.cause
    if (cause === 'rate_limited') return { retryClass: 'rate-limit' }
    return { retryClass: 'transport' }
  }
}
