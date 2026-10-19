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
