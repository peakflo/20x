/**
 * Builds the list of {name, value} secret entries a given agent session can
 * use — the input to a per-session SecretScrubber (see secret-scrubber.ts).
 *
 * Shared by agent-manager.ts (builds the scrubber used at the sendToRenderer
 * choke point and everywhere else output is stored/sent) and by
 * claude-code-adapter.ts (builds the same entries locally so its PostToolUse
 * hook can scrub the Bash tool result before the model ever sees it, without
 * needing agent-manager to thread a pre-built scrubber through the adapter
 * interface).
 *
 * Covers: the agent's configured secrets (secretEnvVars), its provider API
 * keys (apiKeys), OAuth/MCP bearer tokens and local MCP server env baked
 * into mcpServers, and every known provider credential var present in this
 * process's own environment (see harness-env.ts) — a value this session's
 * harness may have been handed even though it didn't ask for it.
 */

import type { SessionConfig, McpServerConfig } from './adapters/coding-agent-adapter'
import type { SecretEntry } from './secret-scrubber'
import { KNOWN_PROVIDER_CREDENTIAL_ENV_VARS } from './adapters/harness-env'
import type { DatabaseManager } from './database'

function sanitizeName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()
}

function bearerToken(headerValue: string | undefined): string | undefined {
  if (!headerValue) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim())
  return match?.[1]
}

export function buildSecretEntriesFromSessionConfig(config: Pick<SessionConfig, 'secretEnvVars' | 'apiKeys' | 'mcpServers'>): SecretEntry[] {
  const entries: SecretEntry[] = []

  for (const [name, value] of Object.entries(config.secretEnvVars || {})) {
    entries.push({ name, value })
  }

  if (config.apiKeys?.openai) entries.push({ name: 'OPENAI_API_KEY', value: config.apiKeys.openai })
  if (config.apiKeys?.anthropic) entries.push({ name: 'ANTHROPIC_API_KEY', value: config.apiKeys.anthropic })
  if (config.apiKeys?.cursor) entries.push({ name: 'CURSOR_AUTH_TOKEN', value: config.apiKeys.cursor })

  for (const [serverName, serverConfig] of Object.entries(config.mcpServers || {})) {
    const mcp = serverConfig as McpServerConfig
    const token = bearerToken(mcp.headers?.Authorization)
    if (token) entries.push({ name: `${sanitizeName(serverName)}_MCP_TOKEN`, value: token })
    if (mcp.env) {
      for (const [envName, envValue] of Object.entries(mcp.env)) {
        entries.push({ name: envName, value: envValue })
      }
    }
  }

  for (const key of KNOWN_PROVIDER_CREDENTIAL_ENV_VARS) {
    const value = process.env[key]
    if (value) entries.push({ name: key, value })
  }

  return entries
}

/**
 * Secret entries for an agent's own configured secrets/API keys (and this
 * app's provider-credential env), independent of any live session config.
 * Used where there's no SessionConfig to read — transcript backfill from
 * persisted CLI history, the one-time scrub migration, context handoff, and
 * the task-management `get_messages` tool (task-api-server.ts), none of
 * which run inside agent-manager.ts's own session machinery.
 */
export function buildSecretEntriesForAgent(
  db: Pick<DatabaseManager, 'getAgent' | 'getSecretsWithValues'>,
  agentId: string | null | undefined
): SecretEntry[] {
  if (!agentId) return []
  const agent = db.getAgent(agentId)
  if (!agent) return []
  const secretIds = agent.config?.secret_ids
  const secretEnvVars: Record<string, string> = {}
  if (secretIds && secretIds.length > 0) {
    for (const s of db.getSecretsWithValues(secretIds)) {
      secretEnvVars[s.env_var_name] = s.value
    }
  }
  return buildSecretEntriesFromSessionConfig({ secretEnvVars, apiKeys: agent.config?.api_keys })
}

/**
 * Secret entries for EVERY secret this installation has ever stored, plus
 * every agent's provider API keys — not scoped to one agent or one task.
 *
 * `buildSecretEntriesForAgent` only covers the secrets a task's CURRENT
 * agent is configured with right now. That misses: a task whose agent was
 * later reassigned or deleted (the row's `agent_id` no longer resolves, or
 * resolves to a different agent than the one that actually produced the
 * transcript); a secret that was removed from an agent's `secret_ids` after
 * the run that leaked it; and a value that leaked into one agent's
 * transcript but belongs to another agent entirely (shared secrets, copied
 * context, subtask handoff). A one-time historical scrub should treat every
 * secret value this app has ever held as something that COULD be sitting in
 * old transcript text, regardless of which task/agent row it's currently
 * attached to. Used by the migration and by `get_messages`' backfill path.
 */
export function buildAllKnownSecretEntries(
  db: Pick<DatabaseManager, 'getAgents' | 'getSecrets' | 'getSecretsWithValues'>
): SecretEntry[] {
  const entries: SecretEntry[] = []

  const allSecretIds = db.getSecrets().map((s) => s.id)
  for (const s of db.getSecretsWithValues(allSecretIds)) {
    entries.push({ name: s.env_var_name, value: s.value })
  }

  for (const agent of db.getAgents()) {
    const apiKeys = agent.config?.api_keys
    if (apiKeys?.openai) entries.push({ name: 'OPENAI_API_KEY', value: apiKeys.openai })
    if (apiKeys?.anthropic) entries.push({ name: 'ANTHROPIC_API_KEY', value: apiKeys.anthropic })
    if (apiKeys?.cursor) entries.push({ name: 'CURSOR_AUTH_TOKEN', value: apiKeys.cursor })
  }

  for (const key of KNOWN_PROVIDER_CREDENTIAL_ENV_VARS) {
    const value = process.env[key]
    if (value) entries.push({ name: key, value })
  }

  return entries
}
