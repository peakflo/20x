/**
 * MCP OAuth Discovery Module
 *
 * Implements the MCP Authorization spec (2025-11-25) discovery flow:
 * 1. Probe MCP server for 401 → extract WWW-Authenticate header
 * 2. Discover Protected Resource Metadata (RFC 9728)
 * 3. Discover Authorization Server Metadata (RFC 8414 / OpenID Connect)
 * 4. Dynamic Client Registration (RFC 7591)
 *
 * @see https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
 */

const FETCH_TIMEOUT = 10_000

/** RFC 9728 Protected Resource Metadata */
export interface ProtectedResourceMetadata {
  resource: string
  authorization_servers: string[]
  scopes_supported?: string[]
  bearer_methods_supported?: string[]
}

/** RFC 8414 Authorization Server Metadata */
export interface AuthorizationServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  revocation_endpoint?: string
  scopes_supported?: string[]
  code_challenge_methods_supported?: string[]
  grant_types_supported?: string[]
  response_types_supported?: string[]
  client_id_metadata_document_supported?: boolean
}

/** RFC 7591 Dynamic Client Registration Response */
export interface DcrResponse {
  client_id: string
  client_secret?: string
  client_id_issued_at?: number
  client_secret_expires_at?: number
}

/** Result of probing an MCP server for auth requirements */
export interface ProbeResult {
  requiresAuth: boolean
  wwwAuthenticate?: string
  resourceMetadataUrl?: string
  scope?: string
}

/** Full discovery result */
export interface DiscoveryResult {
  resourceUrl: string
  authorizationServerUrl: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
  revocationEndpoint?: string
  scopes?: string
  codeChallengeMethodsSupported?: string[]
  clientId?: string
  clientSecret?: string
  registrationMethod?: 'dcr' | 'manual'
  needsManualClientId: boolean
}

/**
 * Fetch JSON with timeout. Returns null on failure.
 */
async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT)
    })
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}

/**
 * Parse a URL into origin and path components.
 */
function parseUrlParts(url: string): { origin: string; path: string } {
  const parsed = new URL(url)
  const path = parsed.pathname === '/' ? '' : parsed.pathname
  return { origin: parsed.origin, path }
}

/**
 * Parse the WWW-Authenticate header for resource_metadata and scope values.
 */
function parseWwwAuthenticate(header: string): { resourceMetadataUrl?: string; scope?: string } {
  const result: { resourceMetadataUrl?: string; scope?: string } = {}

  // Match resource_metadata="..." (quoted)
  const rmMatch = header.match(/resource_metadata="([^"]+)"/)
  if (rmMatch) {
    result.resourceMetadataUrl = rmMatch[1]
  }

  // Match scope="..." (quoted)
  const scopeMatch = header.match(/scope="([^"]+)"/)
  if (scopeMatch) {
    result.scope = scopeMatch[1]
  }

  return result
}

export class McpDiscovery {
  /**
   * Step 1: Probe MCP server for auth requirements.
   *
   * Sends an unauthenticated request and checks for 401.
   * Per spec, MCP servers MUST return 401 with WWW-Authenticate header.
   */
  static async probeForAuth(serverUrl: string): Promise<ProbeResult> {
    try {
      const response = await fetch(serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: '20x', version: '1.0' } },
          id: 1
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT)
      })

      if (response.status === 401) {
        const wwwAuth = response.headers.get('www-authenticate') || ''
        const parsed = parseWwwAuthenticate(wwwAuth)
        return {
          requiresAuth: true,
          wwwAuthenticate: wwwAuth || undefined,
          resourceMetadataUrl: parsed.resourceMetadataUrl,
          scope: parsed.scope
        }
      }

      // Server responded with non-401 — no auth required
      return { requiresAuth: false }
    } catch {
      // Network error — can't determine, assume no auth
      return { requiresAuth: false }
    }
  }

  /**
   * Step 2: Discover Protected Resource Metadata (RFC 9728).
   *
   * Try in order:
   * 1. Fetch from resource_metadata URL (from WWW-Authenticate header)
   * 2. GET /.well-known/oauth-protected-resource/{path}
   * 3. GET /.well-known/oauth-protected-resource (root)
   */
  static async discoverProtectedResource(
    serverUrl: string,
    resourceMetadataUrl?: string
  ): Promise<ProtectedResourceMetadata | null> {
    // 1. Try explicit resource_metadata URL from WWW-Authenticate
    if (resourceMetadataUrl) {
      const meta = await fetchJson<ProtectedResourceMetadata>(resourceMetadataUrl)
      if (meta?.authorization_servers?.length) return meta
    }

    const { origin, path } = parseUrlParts(serverUrl)

    // 2. Try path-specific well-known URI
    if (path) {
      const meta = await fetchJson<ProtectedResourceMetadata>(
        `${origin}/.well-known/oauth-protected-resource${path}`
      )
      if (meta?.authorization_servers?.length) return meta
    }

    // 3. Fallback to root well-known URI
    const meta = await fetchJson<ProtectedResourceMetadata>(
      `${origin}/.well-known/oauth-protected-resource`
    )
    if (meta?.authorization_servers?.length) return meta

    return null
  }

  /**
   * Step 3: Discover Authorization Server Metadata (RFC 8414 + OIDC).
   *
   * For AS URLs with path: try 3 endpoints in priority order.
   * For AS URLs without path: try 2 endpoints.
   */
  static async discoverAuthorizationServer(
    authServerUrl: string
  ): Promise<AuthorizationServerMetadata | null> {
    const { origin, path } = parseUrlParts(authServerUrl)

    const urls: string[] = []

    if (path) {
      // Path-aware discovery
      urls.push(`${origin}/.well-known/oauth-authorization-server${path}`)
      urls.push(`${origin}/.well-known/openid-configuration${path}`)
      urls.push(`${origin}${path}/.well-known/openid-configuration`)
    } else {
      // Root discovery
      urls.push(`${origin}/.well-known/oauth-authorization-server`)
      urls.push(`${origin}/.well-known/openid-configuration`)
    }

    for (const url of urls) {
      const meta = await fetchJson<AuthorizationServerMetadata>(url)
      if (meta?.authorization_endpoint && meta?.token_endpoint) {
        return meta
      }
    }

    return null
  }

  /**
   * Step 4: Dynamic Client Registration (RFC 7591).
   *
   * Registers 20x as a public OAuth client with the authorization server.
   * Uses token_endpoint_auth_method: "none" per OAuth 2.1 for public clients.
   */
  static async registerClient(
    registrationEndpoint: string,
    redirectUri: string
  ): Promise<DcrResponse | null> {
    try {
      const response = await fetch(registrationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: '20x Desktop',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none'
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT)
      })

      if (!response.ok) {
        console.warn(`[mcp-discovery] DCR failed: ${response.status} ${response.statusText}`)
        return null
      }

      return (await response.json()) as DcrResponse
    } catch (err) {
      console.warn('[mcp-discovery] DCR error:', err)
      return null
    }
  }

  /**
   * Full discovery pipeline.
   *
   * Runs: probe → Protected Resource Metadata → AS Metadata → DCR.
   * Returns all data needed for McpOAuthRegistration.
   */
  static async discover(serverUrl: string, redirectUri: string): Promise<DiscoveryResult> {
    // Step 1: Probe for auth
    const probe = await McpDiscovery.probeForAuth(serverUrl)
    if (!probe.requiresAuth) {
      throw new Error('Server does not require authentication')
    }

    // Step 2: Discover Protected Resource Metadata
    const prm = await McpDiscovery.discoverProtectedResource(serverUrl, probe.resourceMetadataUrl)
    if (!prm) {
      throw new Error(
        'Server requires auth but does not advertise OAuth Protected Resource Metadata. ' +
        'Expected /.well-known/oauth-protected-resource or WWW-Authenticate resource_metadata header.'
      )
    }

    // Step 3: Discover Authorization Server Metadata
    let asMeta: AuthorizationServerMetadata | null = null
    for (const asUrl of prm.authorization_servers) {
      asMeta = await McpDiscovery.discoverAuthorizationServer(asUrl)
      if (asMeta) break
    }

    if (!asMeta) {
      throw new Error(
        `Could not discover Authorization Server metadata from: ${prm.authorization_servers.join(', ')}`
      )
    }

    // Determine scopes: prefer WWW-Authenticate scope, then PRM scopes_supported
    const scopes = probe.scope || prm.scopes_supported?.join(' ') || undefined

    // Verify PKCE support
    if (
      asMeta.code_challenge_methods_supported &&
      !asMeta.code_challenge_methods_supported.includes('S256')
    ) {
      throw new Error('Authorization server does not support S256 PKCE code challenge method')
    }

    const result: DiscoveryResult = {
      resourceUrl: prm.resource || serverUrl,
      authorizationServerUrl: asMeta.issuer || prm.authorization_servers[0],
      authorizationEndpoint: asMeta.authorization_endpoint,
      tokenEndpoint: asMeta.token_endpoint,
      registrationEndpoint: asMeta.registration_endpoint,
      revocationEndpoint: asMeta.revocation_endpoint,
      scopes,
      codeChallengeMethodsSupported: asMeta.code_challenge_methods_supported,
      needsManualClientId: true
    }

    // Step 4: Try Dynamic Client Registration
    if (asMeta.registration_endpoint) {
      const dcr = await McpDiscovery.registerClient(asMeta.registration_endpoint, redirectUri)
      if (dcr) {
        result.clientId = dcr.client_id
        result.clientSecret = dcr.client_secret
        result.registrationMethod = 'dcr'
        result.needsManualClientId = false
      }
    }

    return result
  }
}
