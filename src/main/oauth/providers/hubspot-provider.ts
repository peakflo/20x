/**
 * HubSpot OAuth Provider
 *
 * Implements OAuth 2.0 flow for HubSpot API.
 * Uses localhost redirect (http://localhost:3000-3010/callback) because HubSpot doesn't support custom URL schemes.
 *
 * Required scopes:
 * - tickets: Access to ticket objects
 * - crm.objects.contacts.read: Read contact information
 * - crm.objects.owners.read: Read owner/user information
 * - files: Access to file attachments
 * - forms-uploaded-files: Access to files uploaded through forms
 */

import type { OAuthProvider, TokenResponse } from '../oauth-provider'

export class HubSpotProvider implements OAuthProvider {
  readonly id = 'hubspot'
  readonly requiresLocalhost = true // HubSpot doesn't support custom URL schemes

  generateAuthUrl(
    config: Record<string, unknown>,
    state: string,
    challenge: string,
    redirectUri?: string
  ): string {
    const params = new URLSearchParams({
      client_id: config.client_id as string,
      redirect_uri: redirectUri || 'http://localhost:3000/callback',
      scope: 'tickets crm.objects.contacts.read crm.objects.owners.read files forms-uploaded-files',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    })

    return `https://app.hubspot.com/oauth/authorize?${params}`
  }

  async exchangeCode(
    code: string,
    verifier: string,
    config: Record<string, unknown>,
    redirectUri?: string
  ): Promise<TokenResponse> {
    const response = await fetch('https://api.hubapi.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.client_id as string,
        client_secret: config.client_secret as string,
        redirect_uri: redirectUri || 'http://localhost:3000/callback',
        code,
        code_verifier: verifier
      })
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`HubSpot token exchange failed: ${response.status} ${errorText}`)
    }

    return await response.json()
  }

  async refreshToken(
    refreshToken: string,
    clientId: string,
    clientSecret: string
  ): Promise<TokenResponse> {
    const response = await fetch('https://api.hubapi.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken
      })
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`HubSpot token refresh failed: ${response.status} ${errorText}`)
    }

    return await response.json()
  }
}
