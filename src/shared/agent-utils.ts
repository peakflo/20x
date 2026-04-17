/**
 * Shared agent utilities — safe to import from main, renderer, and mobile.
 *
 * Keep this file free of framework imports (no React, no Electron, no Node-only
 * modules) so it can be pulled in from every entry point.
 */

/** Shape this helper expects from an agent-like value. */
export interface AgentConfigLike {
  coding_agent?: string | null
  model?: string | null
}

export interface AgentLike {
  config?: AgentConfigLike | Record<string, unknown> | null
}

function readConfigField(config: AgentLike['config'], key: 'coding_agent' | 'model'): string | undefined {
  if (!config || typeof config !== 'object') return undefined
  const value = (config as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Returns true when the agent has both a provider (coding_agent) and a model
 * selected — the minimum required to start/triage a task with this agent.
 *
 * An agent is considered "unconfigured" when either field is missing/empty,
 * and the UI should block start/triage actions until the user edits it.
 */
export function isAgentConfigured(agent: AgentLike | null | undefined): boolean {
  if (!agent) return false
  const codingAgent = readConfigField(agent.config, 'coding_agent')
  const model = readConfigField(agent.config, 'model')
  return Boolean(codingAgent && codingAgent.trim() && model && model.trim())
}

/**
 * Returns a short, user-facing reason why the agent is unconfigured. Returns
 * null when the agent is fully configured.
 */
export function getAgentConfigIssue(agent: AgentLike | null | undefined): string | null {
  if (!agent) return 'No agent selected'
  const codingAgent = readConfigField(agent.config, 'coding_agent')
  const model = readConfigField(agent.config, 'model')
  const hasProvider = Boolean(codingAgent && codingAgent.trim())
  const hasModel = Boolean(model && model.trim())
  if (!hasProvider && !hasModel) return 'Provider and model are not selected'
  if (!hasProvider) return 'Provider is not selected'
  if (!hasModel) return 'Model is not selected'
  return null
}
