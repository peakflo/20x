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
  acp_instance_id?: string | null
}

export interface AgentLike {
  config?: AgentConfigLike | Record<string, unknown> | null
}

function readConfigField(config: AgentLike['config'], key: 'coding_agent' | 'model' | 'acp_instance_id'): string | undefined {
  if (!config || typeof config !== 'object') return undefined
  const value = (config as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * A model id isn't meaningful to require up front for an ACP agent: the
 * adapter starts a session fine with no model set (it just doesn't send an
 * explicit `session/model` call and the agent uses its own default/"auto"
 * — see `AcpAgentAdapter.createSession`'s `if (config.model && ...)` guard),
 * and many registry agents don't declare one ahead of time at all. What an
 * ACP agent genuinely can't start without is *which* instance (install or
 * local command) to run.
 */
function isAcp(codingAgent: string | undefined): boolean {
  return codingAgent === 'acp'
}

/**
 * Returns true when the agent has a provider (coding_agent) and whatever
 * else that provider needs to actually start a session — a model for every
 * other provider, or a selected instance for an ACP agent — the minimum
 * required to start/triage a task with this agent.
 *
 * An agent is considered "unconfigured" when a required field is
 * missing/empty, and the UI should block start/triage actions until the
 * user edits it.
 */
export function isAgentConfigured(agent: AgentLike | null | undefined): boolean {
  if (!agent) return false
  const codingAgent = readConfigField(agent.config, 'coding_agent')
  if (!codingAgent || !codingAgent.trim()) return false
  if (isAcp(codingAgent)) {
    const instanceId = readConfigField(agent.config, 'acp_instance_id')
    return Boolean(instanceId && instanceId.trim())
  }
  const model = readConfigField(agent.config, 'model')
  return Boolean(model && model.trim())
}

/**
 * Returns a short, user-facing reason why the agent is unconfigured. Returns
 * null when the agent is fully configured.
 */
export function getAgentConfigIssue(agent: AgentLike | null | undefined): string | null {
  if (!agent) return 'No agent selected'
  const codingAgent = readConfigField(agent.config, 'coding_agent')
  const hasProvider = Boolean(codingAgent && codingAgent.trim())
  if (isAcp(codingAgent)) {
    if (!hasProvider) return 'Provider is not selected'
    const instanceId = readConfigField(agent.config, 'acp_instance_id')
    if (!instanceId || !instanceId.trim()) return 'ACP agent instance is not selected'
    return null
  }
  const model = readConfigField(agent.config, 'model')
  const hasModel = Boolean(model && model.trim())
  if (!hasProvider && !hasModel) return 'Provider and model are not selected'
  if (!hasProvider) return 'Provider is not selected'
  if (!hasModel) return 'Model is not selected'
  return null
}
