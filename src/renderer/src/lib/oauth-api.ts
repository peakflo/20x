/**
 * OAuth API client for IPC communication
 */

export const oauthApi = {
  /**
   * Generate OAuth authorization URL
   */
  startFlow: (provider: string, config: Record<string, unknown>): Promise<string> =>
    window.electronAPI.oauth.startFlow(provider, config),

  /**
   * Exchange authorization code for access token
   */
  exchangeCode: (provider: string, code: string, state: string, sourceId: string): Promise<void> =>
    window.electronAPI.oauth.exchangeCode(provider, code, state, sourceId),

  /**
   * Get a valid access token (refreshes if needed)
   */
  getValidToken: (sourceId: string): Promise<string | null> =>
    window.electronAPI.oauth.getValidToken(sourceId),

  /**
   * Revoke OAuth token for a source
   */
  revokeToken: (sourceId: string): Promise<void> =>
    window.electronAPI.oauth.revokeToken(sourceId)
}
