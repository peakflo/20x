import { beforeEach, describe, expect, it, vi } from 'vitest'

// Track Notification calls
const mockNotificationShow = vi.fn()
const mockNotificationConstructor = vi.fn()

// Mock electron before importing the module
vi.mock('electron', () => ({
  app: { isPackaged: false },
  shell: { openExternal: vi.fn() },
  Notification: function MockNotification(opts: { title: string; body: string }) {
    mockNotificationConstructor(opts)
    return { show: mockNotificationShow }
  }
}))

// Mock all OAuth providers to avoid real HTTP calls
vi.mock('./providers', () => ({
  LinearProvider: class { id = 'linear' },
  HubSpotProvider: class { id = 'hubspot' },
  McpOAuthProvider: class {
    id = 'mcp-server'
    refreshToken = vi.fn()
  }
}))

// Mock local OAuth server
vi.mock('./local-oauth-server', () => ({
  LocalOAuthServer: class {
    start = vi.fn()
    stop = vi.fn()
  }
}))

// Mock MCP discovery
vi.mock('./mcp-discovery', () => ({
  McpDiscovery: { probeForAuth: vi.fn() }
}))

import { OAuthManager } from './oauth-manager'

// ── Helpers ──────────────────────────────────────────────────────

function makeTokenRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tok-1',
    provider: 'mcp-server',
    source_id: null,
    mcp_server_id: 'srv-notion',
    access_token: 'old-access-token',
    refresh_token: 'old-refresh-token',
    expires_at: new Date(Date.now() - 60_000).toISOString(), // already expired
    scope: null,
    token_type: 'Bearer',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides
  }
}

function makeMockDb(tokenRecord = makeTokenRecord()) {
  let storedToken: ReturnType<typeof makeTokenRecord> | null = tokenRecord

  return {
    getOAuthTokenByMcpServer: vi.fn((id: string) => {
      if (id === tokenRecord.mcp_server_id) return storedToken
      return null
    }),
    getMcpServer: vi.fn((id: string) => {
      if (id === 'srv-notion') {
        return {
          id: 'srv-notion',
          name: 'Notion MCP',
          oauth_metadata: {
            client_id: 'cid',
            client_secret: 'csec',
            token_endpoint: 'https://api.notion.com/v1/oauth/token'
          }
        }
      }
      return undefined
    }),
    deleteOAuthTokenByMcpServer: vi.fn((id: string) => {
      if (id === tokenRecord.mcp_server_id) storedToken = null
    }),
    deleteOAuthToken: vi.fn(),
    updateOAuthToken: vi.fn(),
    // Stub out methods called by constructor/init that we don't care about
    _storedToken: () => storedToken
  }
}

// ── Tests ────────────────────────────────────────────────────────

describe('OAuthManager — refresh failure cleanup', () => {
  let manager: OAuthManager
  let mockDb: ReturnType<typeof makeMockDb>

  beforeEach(() => {
    mockNotificationShow.mockClear()
    mockNotificationConstructor.mockClear()

    mockDb = makeMockDb()
    manager = new OAuthManager(mockDb as never)
  })

  it('deletes stale token when refresh fails with invalid_grant', async () => {
    // Make the MCP provider refreshToken throw invalid_grant
    const mcpProvider = (manager as any).providers.get('mcp-server')
    mcpProvider.refreshToken = vi.fn().mockRejectedValue(
      new Error('MCP OAuth token refresh failed: 400 {"error":"invalid_grant","error_description":"Invalid refresh token"}')
    )

    const result = await manager.getValidMcpServerToken('srv-notion')

    expect(result).toBeNull()
    expect(mockDb.deleteOAuthTokenByMcpServer).toHaveBeenCalledWith('srv-notion')
  })

  it('shows notification on refresh failure (once per server)', async () => {
    const mcpProvider = (manager as any).providers.get('mcp-server')
    mcpProvider.refreshToken = vi.fn().mockRejectedValue(
      new Error('invalid_grant: token revoked')
    )

    await manager.getValidMcpServerToken('srv-notion')

    expect(mockNotificationConstructor).toHaveBeenCalledTimes(1)
    expect(mockNotificationConstructor).toHaveBeenCalledWith({
      title: 'MCP OAuth Expired',
      body: '"Notion MCP" OAuth token is invalid — please re-authenticate in Settings → Tools.'
    })
    expect(mockNotificationShow).toHaveBeenCalledTimes(1)
  })

  it('deduplicates notifications — only once per server per app run', async () => {
    const mcpProvider = (manager as any).providers.get('mcp-server')
    mcpProvider.refreshToken = vi.fn().mockRejectedValue(
      new Error('invalid_grant')
    )

    // Call 3 times
    await manager.getValidMcpServerToken('srv-notion')
    await manager.getValidMcpServerToken('srv-notion')
    await manager.getValidMcpServerToken('srv-notion')

    // After first call, token is deleted, so subsequent calls return null early (no token record).
    // But notification should still only fire once.
    expect(mockNotificationConstructor).toHaveBeenCalledTimes(1)
    expect(mockNotificationShow).toHaveBeenCalledTimes(1)
  })

  it('does NOT delete token on transient errors (non-invalid_grant)', async () => {
    const mcpProvider = (manager as any).providers.get('mcp-server')
    mcpProvider.refreshToken = vi.fn().mockRejectedValue(
      new Error('Network timeout')
    )

    const result = await manager.getValidMcpServerToken('srv-notion')

    expect(result).toBeNull()
    // Token should NOT be deleted for transient errors
    expect(mockDb.deleteOAuthTokenByMcpServer).not.toHaveBeenCalled()
    // But notification should still fire to inform the user
    expect(mockNotificationConstructor).toHaveBeenCalledTimes(1)
  })

  it('after stale token cleanup, getMcpServerOAuthStatus returns disconnected', async () => {
    const mcpProvider = (manager as any).providers.get('mcp-server')
    mcpProvider.refreshToken = vi.fn().mockRejectedValue(
      new Error('invalid_grant: Invalid refresh token')
    )

    // Before: status shows connected
    const beforeStatus = manager.getMcpServerOAuthStatus('srv-notion')
    expect(beforeStatus.connected).toBe(true)

    // Trigger refresh failure
    await manager.getValidMcpServerToken('srv-notion')

    // After: token deleted, status shows disconnected
    const afterStatus = manager.getMcpServerOAuthStatus('srv-notion')
    expect(afterStatus.connected).toBe(false)
  })

  it('returns valid token without refresh when not expired', async () => {
    // Create token that's still valid (expires in 1 hour)
    const freshDb = makeMockDb(makeTokenRecord({
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      access_token: 'still-valid-token'
    }))
    const freshManager = new OAuthManager(freshDb as never)

    const result = await freshManager.getValidMcpServerToken('srv-notion')

    expect(result).toBe('still-valid-token')
    expect(mockNotificationConstructor).not.toHaveBeenCalled()
  })
})
