/**
 * OAuth Manager
 *
 * Generic OAuth 2.0 orchestrator that delegates provider-specific logic to OAuthProvider implementations.
 * Handles PKCE flow, token storage, refresh scheduling, and localhost server for providers that need it.
 */

import { createId } from '@paralleldrive/cuid2'
import { randomBytes, createHash } from 'crypto'
import { shell } from 'electron'
import type { DatabaseManager } from '../database'
import { LocalOAuthServer } from './local-oauth-server'
import type { OAuthProvider } from './oauth-provider'
import { LinearProvider, HubSpotProvider } from './providers'

interface PendingFlow {
  verifier: string
  config: Record<string, unknown>
}

export class OAuthManager {
  private db: DatabaseManager
  private providers: Map<string, OAuthProvider>
  private pendingFlows: Map<string, PendingFlow>
  private refreshScheduler?: NodeJS.Timeout

  constructor(db: DatabaseManager) {
    this.db = db
    this.providers = new Map()
    this.pendingFlows = new Map()

    // Register available providers
    this.registerProvider(new LinearProvider())
    this.registerProvider(new HubSpotProvider())

    this.startRefreshScheduler()
  }

  /**
   * Register an OAuth provider
   */
  private registerProvider(provider: OAuthProvider): void {
    this.providers.set(provider.id, provider)
    console.log(`[OAuthManager] Registered provider: ${provider.id}`)
  }

  /**
   * Get a registered provider by ID
   */
  private getProvider(providerId: string): OAuthProvider {
    const provider = this.providers.get(providerId)
    if (!provider) {
      throw new Error(`Unknown OAuth provider: ${providerId}`)
    }
    return provider
  }

  /**
   * Generate PKCE code verifier and challenge
   */
  private generatePKCE(): { verifier: string; challenge: string } {
    // Generate 43-128 character random string
    const verifier = randomBytes(32).toString('base64url')

    // Create SHA256 hash and base64url encode
    const challenge = createHash('sha256').update(verifier).digest('base64url')

    return { verifier, challenge }
  }

  /**
   * Generate OAuth authorization URL with PKCE
   * For custom URL scheme providers (Linear), returns the URL directly.
   * For localhost providers (HubSpot), this is handled by startLocalhostOAuthFlow instead.
   */
  generateAuthUrl(providerId: string, config: Record<string, unknown>): string {
    const provider = this.getProvider(providerId)

    if (provider.requiresLocalhost) {
      throw new Error(
        `Provider ${providerId} requires localhost redirect. Use startLocalhostOAuthFlow instead.`
      )
    }

    const { verifier, challenge } = this.generatePKCE()
    const state = createId()

    // Store verifier for later exchange
    this.pendingFlows.set(state, { verifier, config })

    return provider.generateAuthUrl(config, state, challenge)
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCode(
    providerId: string,
    code: string,
    state: string,
    sourceId: string
  ): Promise<void> {
    const provider = this.getProvider(providerId)

    // Retrieve pending flow
    const pending = this.pendingFlows.get(state)
    if (!pending) {
      throw new Error('Invalid OAuth state parameter')
    }

    try {
      const data = await provider.exchangeCode(code, pending.verifier, pending.config)

      // Delete existing token for this source if any
      this.db.deleteOAuthTokenBySource(sourceId)

      // Store encrypted token
      this.db.createOAuthToken({
        provider: providerId,
        source_id: sourceId,
        access_token: data.access_token,
        refresh_token: data.refresh_token || null,
        expires_in: data.expires_in,
        scope: data.scope || null
      })
    } finally {
      // Clean up pending flow
      this.pendingFlows.delete(state)
    }
  }

  /**
   * Get a valid access token, refreshing if necessary
   */
  async getValidToken(sourceId: string): Promise<string | null> {
    const tokenRecord = this.db.getOAuthTokenBySource(sourceId)
    if (!tokenRecord) {
      return null
    }

    // Check if token expires in < 5 minutes
    const expiresAt = new Date(tokenRecord.expires_at).getTime()
    const nowPlus5Min = Date.now() + 5 * 60 * 1000

    if (expiresAt < nowPlus5Min) {
      // Token expired or expiring soon, refresh it
      try {
        await this.refreshToken(tokenRecord.id, tokenRecord.provider, tokenRecord.refresh_token)

        // Fetch the refreshed token
        const refreshedToken = this.db.getOAuthTokenBySource(sourceId)
        return refreshedToken?.access_token || null
      } catch (error) {
        // If refresh fails (e.g., missing credentials), log and return null
        console.error(`[OAuthManager] Failed to refresh token for source ${sourceId}:`, error)
        return null
      }
    }

    return tokenRecord.access_token
  }

  /**
   * Refresh an expired access token
   */
  private async refreshToken(
    tokenId: string,
    providerId: string,
    refreshToken: string | null
  ): Promise<void> {
    if (!refreshToken) {
      throw new Error('No refresh token available')
    }

    const provider = this.getProvider(providerId)

    // Get the token record to access source
    const tokenRecord = this.db.getOAuthToken(tokenId)
    if (!tokenRecord) {
      throw new Error('Token not found')
    }

    // Get task source to retrieve client credentials
    const taskSource = this.db.getTaskSource(tokenRecord.source_id)
    if (!taskSource) {
      throw new Error('Task source not found')
    }

    const clientId = taskSource.config.client_id as string
    const clientSecret = taskSource.config.client_secret as string

    if (!clientId || !clientSecret) {
      // OAuth credentials missing from config (likely due to config update that didn't preserve them)
      // Delete the invalid token so user can re-authenticate
      console.warn(
        `[OAuthManager] OAuth credentials missing for source ${tokenRecord.source_id}, deleting token`
      )
      this.db.deleteOAuthToken(tokenId)
      throw new Error('OAuth client credentials not found in task source config. Please re-authenticate.')
    }

    // Delegate to provider
    const data = await provider.refreshToken(refreshToken, clientId, clientSecret)

    // Update token in database
    this.db.updateOAuthToken(
      tokenId,
      data.access_token,
      data.refresh_token || refreshToken, // Use new refresh token if provided, otherwise keep old one
      data.expires_in
    )
  }

  /**
   * Revoke OAuth token for a source
   */
  async revokeToken(sourceId: string): Promise<void> {
    const tokenRecord = this.db.getOAuthTokenBySource(sourceId)
    if (!tokenRecord) {
      return
    }

    // Most providers don't have a revocation endpoint
    // Just delete from our database
    this.db.deleteOAuthToken(tokenRecord.id)
  }

  /**
   * Start OAuth flow with localhost redirect (for providers like HubSpot)
   * This is a complete flow that handles: server start → auth → callback → token exchange
   */
  async startLocalhostOAuthFlow(
    providerId: string,
    config: Record<string, unknown>,
    sourceId: string
  ): Promise<void> {
    const provider = this.getProvider(providerId)

    if (!provider.requiresLocalhost) {
      throw new Error(
        `Provider ${providerId} doesn't require localhost redirect. Use generateAuthUrl instead.`
      )
    }

    const server = new LocalOAuthServer()

    try {
      // Start local server and get redirect URI
      const redirectUri = await server.start()
      console.log(`[OAuthManager] Local server started with redirect URI: ${redirectUri}`)

      // Generate PKCE
      const { verifier, challenge } = this.generatePKCE()
      const state = createId()

      // Build auth URL with localhost redirect
      const authUrl = provider.generateAuthUrl(config, state, challenge, redirectUri)

      // Open auth URL in browser
      console.log(`[OAuthManager] Opening auth URL in browser`)
      await shell.openExternal(authUrl)

      // Wait for callback from server
      console.log(`[OAuthManager] Waiting for OAuth callback...`)
      const callback = await server.waitForCallback()

      // Verify state matches
      if (callback.state !== state) {
        throw new Error('OAuth state mismatch - possible CSRF attack')
      }

      console.log(`[OAuthManager] Received callback, exchanging code for token`)

      // Exchange code for token
      const data = await provider.exchangeCode(callback.code, verifier, config, redirectUri)

      // Delete existing token for this source if any
      this.db.deleteOAuthTokenBySource(sourceId)

      // Store encrypted token
      this.db.createOAuthToken({
        provider: providerId,
        source_id: sourceId,
        access_token: data.access_token,
        refresh_token: data.refresh_token || null,
        expires_in: data.expires_in,
        scope: data.scope || null
      })

      console.log(`[OAuthManager] OAuth flow completed successfully`)
    } finally {
      // Always stop the server
      server.stop()
    }
  }

  /**
   * Background scheduler to proactively refresh tokens
   * Runs every 12 hours and refreshes tokens expiring within 1 hour
   */
  private startRefreshScheduler(): void {
    // Run every 12 hours
    const TWELVE_HOURS = 12 * 60 * 60 * 1000

    this.refreshScheduler = setInterval(async () => {
      try {
        // This would require a method to get all tokens, which we haven't implemented
        // For now, tokens will be refreshed on-demand when getValidToken is called
        // A future enhancement could add getAllOAuthTokens() and proactively refresh here
      } catch (error) {
        console.error('OAuth token refresh scheduler error:', error)
      }
    }, TWELVE_HOURS)
  }

  /**
   * Stop the refresh scheduler (cleanup on app quit)
   */
  destroy(): void {
    if (this.refreshScheduler) {
      clearInterval(this.refreshScheduler)
      this.refreshScheduler = undefined
    }
  }
}
