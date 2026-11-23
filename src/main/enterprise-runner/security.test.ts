import { describe, expect, it, vi } from 'vitest'
import { MessagePartType, type SessionConfig } from '../adapters/coding-agent-adapter'
import { EnterpriseRunnerAdapter } from '../adapters/enterprise-runner-adapter'
import { HttpRunnerApi, type RunnerAuth } from './runner-api'
import { assertRequestBodySafe, scrubForLog, UnsafeRunnerRequestError } from './scrub'

const SECRET_VALUES = ['sk-live-AAAABBBBCCCCDDDD', 'hunter2-password-value', 'brk_session_token_123456', 'anthropic-key-xyz-987654']

/** Everything a local session config can carry that must stay on this machine. */
const loadedConfig: SessionConfig = {
  agentId: 'a1',
  taskId: 'task-1',
  workspaceDir: '/Users/me/ws',
  secretEnvVars: { STRIPE_KEY: SECRET_VALUES[0], DB_PASSWORD: SECRET_VALUES[1] },
  secretBrokerPort: 54321,
  secretSessionToken: SECRET_VALUES[2],
  secretShellPath: '/tmp/secret-shell.sh',
  apiKeys: { anthropic: SECRET_VALUES[3], openai: 'sk-openai-local-key-000111' },
  harnessHome: '/Users/me/.codex-work',
  mcpServers: {
    'task-management': { type: 'http', url: 'http://127.0.0.1:61234/mcp', headers: { Authorization: 'Bearer local-mcp-token-abcdef' } },
    local: { type: 'stdio', command: 'node', args: ['server.js'], env: { SECRET: 'env-secret-value-1' } }
  }
}

describe('security: nothing local reaches a runner request', () => {
  it('captures every request body of a full session lifecycle and finds no local secret, env var or broker URL', async () => {
    const captured: Array<{ method: string; path: string; body: unknown }> = []
    const auth: RunnerAuth = {
      apiRequest: vi.fn(async (method: string, path: string, body?: unknown) => {
        captured.push({ method, path, body })
        if (path.endsWith('/sessions')) return { session: { id: 's1', status: 'running', runnerId: 'r1' } }
        return {}
      }),
      getJwt: async () => 'jwt',
      getApiUrl: () => 'https://api.peakflo.ai',
      refreshToken: async () => ({ token: 'jwt' })
    }
    const api = new HttpRunnerApi(auth, vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch)
    const data = new Map<string, string>()
    const adapter = new EnterpriseRunnerAdapter({
      api,
      store: { get: (k) => data.get(k), set: (k, v) => void data.set(k, v), delete: (k) => void data.delete(k) },
      ensureServerTask: async () => 'srv-task',
      getEnterpriseAgentId: () => 'srv-agent',
      getRunnerId: () => 'r1',
      getTaskInfo: () => ({ title: 'Task', repositories: ['acme/api'] }),
      currentUserId: () => 'me',
      sleep: () => new Promise(() => undefined)
    })
    const id = await adapter.createSession(loadedConfig)
    await adapter.sendPrompt(id, [{ type: MessagePartType.TEXT, text: 'Work on task' }], loadedConfig)
    await adapter.sendPrompt(id, [{ type: MessagePartType.TEXT, text: 'and also this' }], loadedConfig)
    await adapter.respondToQuestion(id, { q: 'a' }, loadedConfig, 'p1').catch(() => undefined)
    await adapter.abortPrompt(id, loadedConfig)
    await adapter.registerMcpServer()
    await adapter.destroySession(id, loadedConfig)

    expect(captured.length).toBeGreaterThanOrEqual(5)
    const wire = JSON.stringify(captured)
    for (const secret of [...SECRET_VALUES, 'sk-openai-local-key-000111', 'local-mcp-token-abcdef', 'env-secret-value-1']) {
      expect(wire).not.toContain(secret)
    }
    for (const fragment of ['secretEnvVars', 'secretSessionToken', 'secretBrokerPort', 'mcpServers', 'apiKeys', '127.0.0.1', 'STRIPE_KEY', 'harnessHome', '.codex-work', '54321']) {
      expect(wire).not.toContain(fragment)
    }
    // The start request carries exactly the allow-listed fields.
    const start = captured.find((c) => c.path === '/api/coding-agents/sessions')!
    expect(Object.keys(start.body as object).sort()).toEqual(['agentId', 'clientRequestId', 'message', 'repositories', 'runnerId', 'title'])
  })

  it('refuses a body that would carry a local secret value, even in a field the builders do not know', async () => {
    const api = new HttpRunnerApi({
      apiRequest: vi.fn(), getJwt: async () => 'j', getApiUrl: () => 'x', refreshToken: async () => ({ token: 'j' })
    })
    api.setKnownSecrets(['super-secret-value-42'])
    await expect(api.sendMessage('s', { content: 'my key is super-secret-value-42', clientMessageId: 'c' })).rejects.toBeInstanceOf(UnsafeRunnerRequestError)
  })
})

describe('assertRequestBodySafe', () => {
  it('rejects local-only keys at any depth', () => {
    expect(() => assertRequestBodySafe({ a: { b: [{ secretEnvVars: { X: '1' } }] } })).toThrow(UnsafeRunnerRequestError)
    expect(() => assertRequestBodySafe({ mcpServers: {} })).toThrow(UnsafeRunnerRequestError)
    expect(() => assertRequestBodySafe({ env: { PATH: '/bin' } })).toThrow(UnsafeRunnerRequestError)
  })

  it('rejects a local broker or proxy URL outside free text, but allows localhost in a user message', () => {
    expect(() => assertRequestBodySafe({ url: 'http://127.0.0.1:5555/broker' })).toThrow(UnsafeRunnerRequestError)
    expect(() => assertRequestBodySafe({ message: 'start the dev server on http://localhost:3000 and test it' })).not.toThrow()
  })
})

describe('scrubForLog', () => {
  it('redacts bearer tokens, JWTs, key=value secrets and known values', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk'
    const out = scrubForLog(`Authorization: Bearer abc123def456ghi789 jwt=${jwt} api_key=zzzzzzzzzz plus hunter2-password-value`, ['hunter2-password-value'])
    expect(out).not.toContain('abc123def456ghi789')
    expect(out).not.toContain(jwt)
    expect(out).not.toContain('zzzzzzzzzz')
    expect(out).not.toContain('hunter2-password-value')
  })
})
