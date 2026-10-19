import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSecretEntriesFromSessionConfig, buildSecretEntriesForAgent } from './secret-entries'

describe('buildSecretEntriesFromSessionConfig', () => {
  const savedEnv: Record<string, string | undefined> = {}
  const knownKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENCODE_API_KEY', 'CURSOR_AUTH_TOKEN', 'PEAKFLO_AI_GATEWAY_API_KEY']

  beforeEach(() => {
    for (const k of knownKeys) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of knownKeys) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  it('includes secretEnvVars by their own name', () => {
    const entries = buildSecretEntriesFromSessionConfig({ secretEnvVars: { MY_SECRET: 'secretvalue123' } })
    expect(entries).toContainEqual({ name: 'MY_SECRET', value: 'secretvalue123' })
  })

  it('includes configured provider api keys under canonical names', () => {
    const entries = buildSecretEntriesFromSessionConfig({
      apiKeys: { openai: 'sk-openai-value', anthropic: 'sk-anthropic-value', cursor: 'cursor-token-value' }
    })
    expect(entries).toContainEqual({ name: 'OPENAI_API_KEY', value: 'sk-openai-value' })
    expect(entries).toContainEqual({ name: 'ANTHROPIC_API_KEY', value: 'sk-anthropic-value' })
    expect(entries).toContainEqual({ name: 'CURSOR_AUTH_TOKEN', value: 'cursor-token-value' })
  })

  it('extracts the bearer token from a remote MCP server header', () => {
    const entries = buildSecretEntriesFromSessionConfig({
      mcpServers: {
        myserver: { type: 'http', url: 'https://example.com', headers: { Authorization: 'Bearer abc123tokenvalue' } }
      }
    })
    expect(entries).toContainEqual({ name: 'MYSERVER_MCP_TOKEN', value: 'abc123tokenvalue' })
  })

  it('includes local stdio MCP server env vars by their own name', () => {
    const entries = buildSecretEntriesFromSessionConfig({
      mcpServers: {
        localtool: { type: 'stdio', command: 'foo', env: { LOCAL_TOOL_KEY: 'localtoolsecretvalue' } }
      }
    })
    expect(entries).toContainEqual({ name: 'LOCAL_TOOL_KEY', value: 'localtoolsecretvalue' })
  })

  it('picks up known provider credential vars present in process.env', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env'
    const entries = buildSecretEntriesFromSessionConfig({})
    expect(entries).toContainEqual({ name: 'ANTHROPIC_API_KEY', value: 'sk-ant-from-env' })
  })

  it('returns an empty list when there is nothing to scrub', () => {
    expect(buildSecretEntriesFromSessionConfig({})).toEqual([])
  })
})

describe('buildSecretEntriesForAgent', () => {
  function makeDb(overrides: Partial<{ agent: unknown; secrets: Array<{ env_var_name: string; value: string }> }> = {}) {
    const agent = 'agent' in overrides ? overrides.agent : {
      id: 'agent-1',
      config: { secret_ids: ['s1'], api_keys: { openai: 'sk-openai-value-123' } }
    }
    const secrets = overrides.secrets ?? [{ env_var_name: 'MY_SECRET', value: 'secretvalue123' }]
    return {
      getAgent: vi.fn(() => agent),
      getSecretsWithValues: vi.fn(() => secrets)
    } as unknown as Pick<import('./database').DatabaseManager, 'getAgent' | 'getSecretsWithValues'>
  }

  it('returns [] for a null/undefined agentId without touching the db', () => {
    const db = makeDb()
    expect(buildSecretEntriesForAgent(db, null)).toEqual([])
    expect(buildSecretEntriesForAgent(db, undefined)).toEqual([])
    expect(db.getAgent).not.toHaveBeenCalled()
  })

  it('returns [] when the agent does not exist', () => {
    const db = makeDb({ agent: undefined })
    expect(buildSecretEntriesForAgent(db, 'missing')).toEqual([])
  })

  it('combines the agent\'s decrypted secrets and configured api keys', () => {
    const db = makeDb()
    const entries = buildSecretEntriesForAgent(db, 'agent-1')
    expect(entries).toContainEqual({ name: 'MY_SECRET', value: 'secretvalue123' })
    expect(entries).toContainEqual({ name: 'OPENAI_API_KEY', value: 'sk-openai-value-123' })
  })

  it('returns [] for an agent with no secret_ids and no api_keys', () => {
    const db = makeDb({ agent: { id: 'agent-2', config: {} }, secrets: [] })
    expect(buildSecretEntriesForAgent(db, 'agent-2')).toEqual([])
  })
})
