/**
 * MCP Server OAuth Provider
 *
 * Generic OAuth 2.1 provider for MCP servers implementing the
 * MCP Authorization spec (2025-11-25).
 *
 * Reads OAuth endpoints dynamically from the MCP server's stored
 * McpOAuthRegistration (populated via the discovery flow).
 *
 * Includes the mandatory `resource` parameter (RFC 8707) in both
 * authorization requests and token requests.
 */

import type { OAuthProvider, TokenResponse } from '../oauth-provider'

export class McpOAuthProvider implements OAuthProvider {
  readonly id = 'mcp-server'
  readonly requiresLocalhost = true

  generateAuthUrl(
    config: Record<string, unknown>,
    state: string,
    challenge: string,
    redirectUri?: string
  ): string {
    const params = new URLSearchParams({
      client_id: config.client_id as string,
      redirect_uri: redirectUri || 'http://localhost:3000/callback',
      response_type: 'code',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    })

    // RFC 8707: resource parameter is REQUIRED per MCP spec
    if (config.resource_url) {
      params.set('resource', config.resource_url as string)
    }

    if (config.scopes) {
      params.set('scope', config.scopes as string)
    }

    return `${config.authorization_endpoint as string}?${params}`
  }

  async exchangeCode(
    code: string,
    verifier: string,
    config: Record<string, unknown>,
    redirectUri?: string
  ): Promise<TokenResponse> {
    const body: Record<string, string> = {
      grant_type: 'authorization_code',
      client_id: config.client_id as string,
      redirect_uri: redirectUri || 'http://localhost:3000/callback',
      code,
      code_verifier: verifier
    }

    // RFC 8707: resource parameter is REQUIRED per MCP spec
    if (config.resource_url) {
      body.resource = config.resource_url as string
    }

    // Include client_secret if provided (confidential clients from DCR)
    if (config.client_secret) {
      body.client_secret = config.client_secret as string
    }

    const response = await fetch(config.token_endpoint as string, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body)
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`MCP OAuth token exchange failed: ${response.status} ${errorText}`)
    }

    return await response.json()
  }

  async refreshToken(
    refreshToken: string,
    clientId: string,
    clientSecret: string,
    tokenEndpoint?: string
  ): Promise<TokenResponse> {
    if (!tokenEndpoint) {
      throw new Error('Token endpoint required for MCP OAuth refresh')
    }

    const body: Record<string, string> = {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken
    }

    if (clientSecret) {
      body.client_secret = clientSecret
    }

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body)
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`MCP OAuth token refresh failed: ${response.status} ${errorText}`)
    }

    return await response.json()
  }
}
