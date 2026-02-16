/**
 * Linear OAuth Provider
 *
 * Implements OAuth 2.0 flow for Linear API.
 * Uses custom URL scheme (nuanu://oauth/callback) for redirect.
 */

import type { OAuthProvider, TokenResponse } from '../oauth-provider'

export class LinearProvider implements OAuthProvider {
  readonly id = 'linear'
  readonly requiresLocalhost = false // Uses custom URL scheme

  generateAuthUrl(
    config: Record<string, unknown>,
    state: string,
    challenge: string
  ): string {
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

  async exchangeCode(
    code: string,
    verifier: string,
    config: Record<string, unknown>
  ): Promise<TokenResponse> {
    const response = await fetch('https://api.linear.app/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.client_id as string,
        client_secret: config.client_secret as string,
        redirect_uri: 'nuanu://oauth/callback',
        grant_type: 'authorization_code',
        code_verifier: verifier
      })
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Linear token exchange failed: ${response.status} ${errorText}`)
    }

    return await response.json()
  }

  async refreshToken(
    refreshToken: string,
    clientId: string,
    clientSecret: string
  ): Promise<TokenResponse> {
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
      throw new Error(`Linear token refresh failed: ${response.status} ${errorText}`)
    }

    return await response.json()
  }
}
