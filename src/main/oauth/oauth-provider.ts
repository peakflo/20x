/**
 * OAuth Provider Interface
 *
 * Defines the contract for OAuth 2.0 providers.
 * Each provider (Linear, HubSpot, etc.) implements this interface.
 */

export interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
  token_type?: string
}

export interface OAuthProvider {
  /**
   * Unique identifier for this provider (e.g., 'linear', 'hubspot')
   */
  readonly id: string

  /**
   * Whether this provider requires localhost redirect (vs custom URL scheme)
   * true = localhost (e.g., http://localhost:3000/callback)
   * false = custom scheme (e.g., nuanu://oauth/callback)
   */
  readonly requiresLocalhost: boolean

  /**
   * Generate OAuth authorization URL
   * @param config - Plugin configuration (client_id, client_secret, etc.)
   * @param state - CSRF protection state parameter
   * @param challenge - PKCE code challenge
   * @param redirectUri - OAuth redirect URI (for localhost providers)
   * @returns Authorization URL to open in browser
   */
  generateAuthUrl(
    config: Record<string, unknown>,
    state: string,
    challenge: string,
    redirectUri?: string
  ): string

  /**
   * Exchange authorization code for access token
   * @param code - Authorization code from OAuth callback
   * @param verifier - PKCE code verifier
   * @param config - Plugin configuration (client_id, client_secret, etc.)
   * @param redirectUri - OAuth redirect URI (must match the one used in authorization)
   * @returns Token response with access_token, refresh_token, etc.
   */
  exchangeCode(
    code: string,
    verifier: string,
    config: Record<string, unknown>,
    redirectUri?: string
  ): Promise<TokenResponse>

  /**
   * Refresh an expired access token
   * @param refreshToken - The refresh token
   * @param clientId - OAuth client ID
   * @param clientSecret - OAuth client secret
   * @returns Token response with new access_token
   */
  refreshToken(
    refreshToken: string,
    clientId: string,
    clientSecret: string
  ): Promise<TokenResponse>
}
