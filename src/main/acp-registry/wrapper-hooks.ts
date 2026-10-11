/**
 * Thin per-agent extension hooks for the shared ACP client.
 *
 * Most registry/local ACP agents need nothing beyond the generic protocol
 * client. A few need a small amount of agent-specific behavior layered on
 * top — a quirky error code that actually means "rate limited," a model id
 * that isn't literally what the wire protocol expects, a proprietary
 * extension notification. Rather than forking the shared client per agent,
 * each of those gets a small "hooks" object implementing whichever of these
 * optional points it needs; everything left unset falls back to default
 * behavior in the shared client.
 *
 * Hooks are keyed by the *registry* agent id (e.g. "devin", "mistral-vibe"),
 * not by any locally-chosen instance name, and apply equally whether the
 * instance was installed from the registry or pointed at a matching local
 * command.
 *
 * To add a wrapper for a new agent: create `wrappers/<id>.ts` exporting an
 * `AcpWrapperHooks` object, then register it in `WRAPPERS` below. Every hook
 * is optional — implement only what that agent actually needs.
 */

export type AcpErrorClass = 'rate-limit' | 'usage-limit' | 'transport' | 'provider'

export interface AcpSubagentEvent {
  kind: 'started' | 'updated' | 'finished'
  id: string
  title?: string
  status?: string
}

export interface AcpAuthMethodContext {
  /** Auth method ids the agent advertised in `initialize`. */
  availableMethods: string[]
  hasEnvVar: (name: string) => boolean
}

export interface AcpWrapperHooks {
  /** Merged into the `initialize` request's `clientCapabilities`. */
  extraClientCapabilities?: Record<string, unknown>
  /** Merged into the `initialize` request's `_meta`. */
  extraInitializeMeta?: Record<string, unknown>

  /** Handles an agent-specific JSON-RPC extension *request* (the base ACP spec doesn't define it). */
  handleExtensionRequest?: (method: string, params: unknown) => Promise<unknown> | unknown
  /**
   * Handles an agent-specific JSON-RPC extension *notification*. Some agents
   * push a proprietary notification mid-turn (outside the standard
   * session/update stream) to announce their own SDK is backing off and
   * retrying. Returning `{ retryClass }` forwards that into the same
   * generic provider-retry/usage-limit channel a normal error would use.
   */
  handleExtensionNotification?: (method: string, params: unknown) => { retryClass?: AcpErrorClass } | void

  /** Translates the client's selected model id to whatever the wire protocol expects. */
  mapModelIdToWire?: (modelId: string) => string
  /** Interprets the model id the agent reports back as "current model." */
  mapModelIdFromWire?: (wireModelId: string) => string

  /**
   * Classifies a raw prompt/turn failure into a small set of categories.
   * Returning undefined means "no special classification" (treated as a
   * generic provider error).
   */
  classifyError?: (error: unknown) => AcpErrorClass | undefined

  /** Recognizes an agent's own way of reporting a spawned subagent/child task. */
  normalizeSubagentEvent?: (raw: unknown) => AcpSubagentEvent | undefined

  /** Given the agent's advertised auth methods and which env vars are set, picks one automatically. */
  preferredAuthMethod?: (context: AcpAuthMethodContext) => string | undefined
}

import { devinHooks } from './wrappers/devin'
import { mistralVibeHooks } from './wrappers/mistral-vibe'

/** Registered wrappers, keyed by registry agent id. */
const WRAPPERS: Record<string, AcpWrapperHooks> = {
  devin: devinHooks,
  'mistral-vibe': mistralVibeHooks
}

/** Returns the hooks for a registry agent id, or an empty (all-default) object. */
export function getWrapperHooks(registryAgentId: string | null | undefined): AcpWrapperHooks {
  if (!registryAgentId) return {}
  return WRAPPERS[registryAgentId] ?? {}
}

export function registerWrapperHooksForTests(id: string, hooks: AcpWrapperHooks): void {
  WRAPPERS[id] = hooks
}

export function unregisterWrapperHooksForTests(id: string): void {
  delete WRAPPERS[id]
}
