import { createId } from '@paralleldrive/cuid2'
import { randomBytes, createHash } from 'crypto'
import type { DatabaseManager } from './database'

interface PendingFlow {
  verifier: string
  config: Record<string, unknown>
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
  token_type?: string
}

export class OAuthManager {
  private db: DatabaseManager
  private pendingFlows: Map<string, PendingFlow>
  private refreshScheduler?: NodeJS.Timeout

  constructor(db: DatabaseManager) {
    this.db = db
    this.pendingFlows = new Map()
    this.startRefreshScheduler()
  }

  /**
   * Generate PKCE code verifier and challenge
   */
  private generatePKCE(): { verifier: string; challenge: string } {
    // Generate 43-128 character random string
    const verifier = randomBytes(32).toString('base64url')

    // Create SHA256 hash and base64url encode
    const challenge = createHash('sha256')
      .update(verifier)
      .digest('base64url')

    return { verifier, challenge }
  }

  /**
   * Generate OAuth authorization URL with PKCE
   */
  generateAuthUrl(provider: string, config: Record<string, unknown>): string {
    if (provider !== 'linear') {
      throw new Error(`Unsupported OAuth provider: ${provider}`)
    }

    const { verifier, challenge } = this.generatePKCE()
    const state = createId()

    // Store verifier for later exchange
    this.pendingFlows.set(state, { verifier, config })

    // Build Linear auth URL
    // Handle scope as either string or array
    const scopeValue = Array.isArray(config.scope)
      ? config.scope.join(',')
      : (config.scope as string)

    const params = new URLSearchParams({
      client_id: config.client_id as string,
      redirect_uri: 'nuanu://oauth/callback',
      response_type: 'code',
      scope: scopeValue,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    })

    return `https://linear.app/oauth/authorize?${params}`
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCode(
    provider: string,
    code: string,
    state: string,
    sourceId: string
  ): Promise<void> {
    if (provider !== 'linear') {
      throw new Error(`Unsupported OAuth provider: ${provider}`)
    }

    // Retrieve pending flow
    const pending = this.pendingFlows.get(state)
    if (!pending) {
      throw new Error('Invalid OAuth state parameter')
    }

    try {
      // Exchange code for token
      const response = await fetch('https://api.linear.app/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: pending.config.client_id as string,
          client_secret: pending.config.client_secret as string,
          redirect_uri: 'nuanu://oauth/callback',
          grant_type: 'authorization_code',
          code_verifier: pending.verifier
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Token exchange failed: ${response.status} ${errorText}`)
      }

      const data = await response.json() as TokenResponse

      // Delete existing token for this source if any
      this.db.deleteOAuthTokenBySource(sourceId)

      // Store encrypted token
      this.db.createOAuthToken({
        provider,
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
      await this.refreshToken(tokenRecord.id, tokenRecord.provider, tokenRecord.refresh_token)

      // Fetch the refreshed token
      const refreshedToken = this.db.getOAuthTokenBySource(sourceId)
      return refreshedToken?.access_token || null
    }

    return tokenRecord.access_token
  }

  /**
   * Refresh an expired access token
   */
  private async refreshToken(
    tokenId: string,
    provider: string,
    refreshToken: string | null
  ): Promise<void> {
    if (!refreshToken) {
      throw new Error('No refresh token available')
    }

    if (provider !== 'linear') {
      throw new Error(`Unsupported OAuth provider: ${provider}`)
    }

    // Get the token record to access client credentials
    const tokenRecord = this.db.getOAuthToken(tokenId)
    if (!tokenRecord) {
      throw new Error('Token not found')
    }

    // We need client_id and client_secret from the task source config
    // Get the task source to retrieve config
    const taskSource = this.db.getTaskSource(tokenRecord.source_id)
    if (!taskSource) {
      throw new Error('Task source not found')
    }

    const clientId = taskSource.config.client_id as string
    const clientSecret = taskSource.config.client_secret as string

    if (!clientId || !clientSecret) {
      throw new Error('OAuth client credentials not found in task source config')
    }

    // Request new access token using refresh token
    const response = await fetch('https://api.linear.app/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret
      })
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Token refresh failed: ${response.status} ${errorText}`)
    }

    const data = await response.json() as TokenResponse

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

    // Linear doesn't have a revocation endpoint in their docs,
    // so we just delete from our database
    this.db.deleteOAuthToken(tokenRecord.id)
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
