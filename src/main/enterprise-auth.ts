import { app, safeStorage, shell } from 'electron'
import { randomBytes, createHash } from 'crypto'
import { createClient, SupabaseClient, Session } from '@supabase/supabase-js'
import type { DatabaseManager } from './database'
import { LocalOAuthServer } from './oauth/local-oauth-server'

// ── Enterprise environment configs ────────────────────────────────
// Supabase anon keys are public (designed for client-side use).
// They only allow access scoped by Row Level Security policies.

interface EnterpriseEnvConfig {
  supabaseUrl: string
  supabaseAnonKey: string
  apiUrl: string
}

const ENV_CONFIGS: Record<string, EnterpriseEnvConfig> = {
  local: {
    supabaseUrl: 'https://zelvgltpjmxrafmwuhjx.supabase.co',
    supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InplbHZnbHRwam14cmFmbXd1aGp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM3NzI1NDMsImV4cCI6MjA1OTM0ODU0M30.4HML8dzr3f_tDgA3Ej1AgS2Ne9BUsGm2gwGqfN7I_zM',
    apiUrl: 'http://localhost:2000'
  },
  stage: {
    supabaseUrl: 'https://bavjdtdcaujyynvbmhsk.supabase.co',
    supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhdmpkdGRjYXVqeXludmJtaHNrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzcyNTAxNTEsImV4cCI6MjA1MjgyNjE1MX0.2TKaaK66GoHkaiKrnBDT5GVlVBtgz6RLYUhN3o0fp4o',
    apiUrl: 'https://stage-api.peakflo.ai'
  },
  production: {
    supabaseUrl: 'https://ohoqjpdecvktoawiggiv.supabase.co',
    supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ob3FqcGRlY3ZrdG9hd2lnZ2l2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDUxMTg0NTYsImV4cCI6MjA2MDY5NDQ1Nn0.yIPkJnLnf6dQkV8yR5xberRPjoizMxVCH0M4S2ajenM',
    apiUrl: 'https://api.peakflo.ai'
  }
}

function getEnterpriseConfig(): EnterpriseEnvConfig {
  // Allow explicit override via env var (useful for development)
  const envOverride = process.env.ENTERPRISE_ENV
  if (envOverride && ENV_CONFIGS[envOverride]) {
    return ENV_CONFIGS[envOverride]
  }

  // Packaged app → production, dev mode → local
  return app.isPackaged ? ENV_CONFIGS.production : ENV_CONFIGS.local
}

// ── Settings keys (stored in local SQLite) ────────────────────────
const KEYS = {
  SUPABASE_ACCESS_TOKEN: 'enterprise_supabase_access_token',
  SUPABASE_REFRESH_TOKEN: 'enterprise_supabase_refresh_token',
  JWT: 'enterprise_jwt',
  JWT_EXPIRES_AT: 'enterprise_jwt_expires_at',
  USER_EMAIL: 'enterprise_user_email',
  USER_ID: 'enterprise_user_id',
  TENANT_ID: 'enterprise_tenant_id',
  TENANT_NAME: 'enterprise_tenant_name'
} as const

// ── Types ──────────────────────────────────────────────────────────

export interface EnterpriseCompany {
  id: string
  name: string
  isPrimary: boolean
}

export interface EnterpriseLoginResult {
  userId: string
  email: string
  companies: EnterpriseCompany[]
}

export interface EnterpriseSelectTenantResult {
  token: string
  tenant: { id: string; name: string }
}

export interface EnterpriseSession {
  isAuthenticated: boolean
  userEmail: string | null
  userId: string | null
  currentTenant: { id: string; name: string } | null
}

// ── Helpers for encrypted storage ──────────────────────────────────

function encryptValue(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(value).toString('base64')
  }
  return Buffer.from(value, 'utf8').toString('base64')
}

function decryptValue(stored: string): string {
  const buf = Buffer.from(stored, 'base64')
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(buf)
  }
  return buf.toString('utf8')
}

// ── Enterprise Auth Manager ────────────────────────────────────────

export class EnterpriseAuth {
  private db: DatabaseManager
  private supabase: SupabaseClient
  private apiUrl: string
  private config: EnterpriseEnvConfig

  // Cached JWT to avoid DB reads on every request
  private cachedJwt: string | null = null
  private cachedJwtExpiresAt: number = 0

  constructor(db: DatabaseManager) {
    this.db = db

    this.config = getEnterpriseConfig()
    this.apiUrl = this.config.apiUrl

    console.log(`[Enterprise] Using ${app.isPackaged ? 'production' : process.env.ENTERPRISE_ENV || 'local'} config → ${this.config.apiUrl}`)

    this.supabase = createClient(this.config.supabaseUrl, this.config.supabaseAnonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        flowType: 'pkce'
      }
    })
  }

  // ── PKCE helpers ─────────────────────────────────────────────────

  private generatePKCE(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    return { verifier, challenge }
  }

  // ── Login (Supabase OAuth Server flow) ─────────────────────────
  //
  // Follows: https://supabase.com/docs/guides/auth/oauth-server/oauth-flows
  //
  // 1. Redirect to Supabase's /auth/v1/authorize (hosted login UI)
  //    — Supabase decides which providers to show (Google, OIDC, email, etc.)
  // 2. User authenticates in the browser
  // 3. Supabase redirects back with ?code=...
  // 4. We exchange the code + PKCE verifier for tokens via /auth/v1/token

  async login(): Promise<EnterpriseLoginResult> {
    const server = new LocalOAuthServer()

    try {
      // Start local server to receive OAuth callback
      const redirectUri = await server.start()
      console.log(`[Enterprise] OAuth: local server started at ${redirectUri}`)

      // Generate PKCE code verifier and challenge
      const { verifier, challenge } = this.generatePKCE()

      // Build Supabase authorize URL — Supabase shows its hosted login UI
      // with all configured providers (no provider hardcoded on our side)
      const authorizeUrl = new URL(`${this.config.supabaseUrl}/auth/v1/authorize`)
      authorizeUrl.searchParams.set('response_type', 'code')
      authorizeUrl.searchParams.set('client_id', this.config.supabaseAnonKey)
      authorizeUrl.searchParams.set('redirect_uri', redirectUri)
      authorizeUrl.searchParams.set('code_challenge', challenge)
      authorizeUrl.searchParams.set('code_challenge_method', 'S256')

      // Open in system browser — Supabase handles provider selection
      console.log('[Enterprise] OAuth: opening Supabase auth UI in browser')
      await shell.openExternal(authorizeUrl.toString())

      // Wait for callback with auth code
      console.log('[Enterprise] OAuth: waiting for callback...')
      const callback = await server.waitForCallback()

      // Exchange auth code + PKCE verifier for tokens
      // POST /auth/v1/token?grant_type=authorization_code
      console.log('[Enterprise] OAuth: exchanging code for tokens')
      const tokenUrl = `${this.config.supabaseUrl}/auth/v1/token?grant_type=authorization_code`
      const tokenResponse = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': this.config.supabaseAnonKey
        },
        body: JSON.stringify({
          code: callback.code,
          redirect_uri: redirectUri,
          code_verifier: verifier
        })
      })

      if (!tokenResponse.ok) {
        const errBody = await tokenResponse.json().catch(() => ({}))
        throw new Error(errBody.error_description || errBody.msg || `Token exchange failed (${tokenResponse.status})`)
      }

      const tokenData = await tokenResponse.json()

      if (!tokenData.access_token || !tokenData.user) {
        throw new Error('Token exchange returned incomplete data')
      }

      // Build a session-like object for storage
      const session: Session = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token || '',
        expires_in: tokenData.expires_in,
        expires_at: tokenData.expires_at,
        token_type: tokenData.token_type || 'bearer',
        user: tokenData.user
      }

      // Store Supabase tokens (encrypted)
      this.storeSupabaseSession(session)

      // Store basic user info
      const userEmail = tokenData.user.email || ''
      this.db.setSetting(KEYS.USER_EMAIL, userEmail)
      this.db.setSetting(KEYS.USER_ID, tokenData.user.id)

      // Fetch user's companies from the workflow-api
      const companies = await this.fetchCompanies(tokenData.access_token)

      console.log(`[Enterprise] OAuth: login successful for ${userEmail}`)

      return {
        userId: tokenData.user.id,
        email: userEmail,
        companies
      }
    } finally {
      server.stop()
    }
  }

  // ── Select Tenant ────────────────────────────────────────────────

  async selectTenant(tenantId: string): Promise<EnterpriseSelectTenantResult> {
    if (!tenantId) {
      throw new Error('Tenant ID is required')
    }

    const accessToken = this.getStoredSupabaseAccessToken()
    if (!accessToken) {
      throw new Error('Not authenticated — please sign in first')
    }

    const response = await fetch(`${this.apiUrl}/api/20x/auth/select-tenant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({ tenantId })
    })

    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.message || `Failed to select tenant (${response.status})`)
    }

    const result = await response.json()

    // Store JWT (encrypted) and tenant info
    this.storeJwt(result.token, result.expiresIn)
    this.db.setSetting(KEYS.TENANT_ID, result.tenant.id)
    this.db.setSetting(KEYS.TENANT_NAME, result.tenant.name)

    return {
      token: result.token,
      tenant: result.tenant
    }
  }

  // ── Logout ───────────────────────────────────────────────────────

  async logout(): Promise<void> {
    // Sign out from Supabase (best-effort — token may already be invalid)
    try {
      await this.supabase.auth.signOut()
    } catch {
      // Ignore — we clear local state regardless
    }

    // Clear all stored enterprise data
    this.clearStoredData()
  }

  // ── Get Session ──────────────────────────────────────────────────

  async getSession(): Promise<EnterpriseSession> {
    const userId = this.db.getSetting(KEYS.USER_ID)
    const userEmail = this.db.getSetting(KEYS.USER_EMAIL)
    const tenantId = this.db.getSetting(KEYS.TENANT_ID)
    const tenantName = this.db.getSetting(KEYS.TENANT_NAME)
    const hasAccessToken = !!this.db.getSetting(KEYS.SUPABASE_ACCESS_TOKEN)

    if (!userId || !userEmail || !hasAccessToken) {
      return {
        isAuthenticated: false,
        userEmail: null,
        userId: null,
        currentTenant: null
      }
    }

    return {
      isAuthenticated: true,
      userEmail,
      userId,
      currentTenant: tenantId && tenantName ? { id: tenantId, name: tenantName } : null
    }
  }

  // ── Refresh Token ────────────────────────────────────────────────

  async refreshToken(): Promise<{ token: string }> {
    // First refresh the Supabase session
    const refreshToken = this.getStoredSupabaseRefreshToken()
    if (!refreshToken) {
      this.clearStoredData()
      throw new Error('No refresh token available — please sign in again')
    }

    const { data, error } = await this.supabase.auth.refreshSession({
      refresh_token: refreshToken
    })

    if (error || !data.session) {
      this.clearStoredData()
      throw new Error('Session expired — please sign in again')
    }

    // Store updated Supabase tokens
    this.storeSupabaseSession(data.session)

    // Now refresh the pf-workflo JWT
    const tenantId = this.db.getSetting(KEYS.TENANT_ID)
    if (!tenantId) {
      throw new Error('No tenant selected — please select an organization')
    }

    const response = await fetch(`${this.apiUrl}/api/20x/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${data.session.access_token}`
      },
      body: JSON.stringify({ tenantId })
    })

    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.message || `Failed to refresh token (${response.status})`)
    }

    const result = await response.json()
    this.storeJwt(result.token, result.expiresIn)

    return { token: result.token }
  }

  // ── API Request Proxy ────────────────────────────────────────────

  async apiRequest(method: string, path: string, body?: unknown): Promise<unknown> {
    const jwt = await this.getValidJwt()

    const url = `${this.apiUrl}${path.startsWith('/') ? path : `/${path}`}`

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${jwt}`,
      'Content-Type': 'application/json'
    }

    const fetchOptions: RequestInit = {
      method: method.toUpperCase(),
      headers
    }

    if (body !== undefined && method.toUpperCase() !== 'GET') {
      fetchOptions.body = JSON.stringify(body)
    }

    const response = await fetch(url, fetchOptions)

    if (response.status === 401) {
      // Try refreshing the token once
      try {
        await this.refreshToken()
        const retryJwt = await this.getValidJwt()
        headers['Authorization'] = `Bearer ${retryJwt}`
        const retryResponse = await fetch(url, { ...fetchOptions, headers })

        if (!retryResponse.ok) {
          const retryBody = await retryResponse.json().catch(() => ({}))
          throw new Error(retryBody.message || `API request failed (${retryResponse.status})`)
        }

        return retryResponse.json().catch(() => null)
      } catch {
        this.clearStoredData()
        throw new Error('Session expired — please sign in again')
      }
    }

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}))
      throw new Error(errorBody.message || `API request failed (${response.status})`)
    }

    return response.json().catch(() => null)
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async fetchCompanies(accessToken: string): Promise<EnterpriseCompany[]> {
    const response = await fetch(`${this.apiUrl}/api/20x/auth/verify`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    })

    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.message || `Failed to fetch companies (${response.status})`)
    }

    const result = await response.json()
    return result.companies || []
  }

  private storeSupabaseSession(session: Session): void {
    this.db.setSetting(KEYS.SUPABASE_ACCESS_TOKEN, encryptValue(session.access_token))
    if (session.refresh_token) {
      this.db.setSetting(KEYS.SUPABASE_REFRESH_TOKEN, encryptValue(session.refresh_token))
    }
  }

  private getStoredSupabaseAccessToken(): string | null {
    const stored = this.db.getSetting(KEYS.SUPABASE_ACCESS_TOKEN)
    if (!stored) return null
    try {
      return decryptValue(stored)
    } catch {
      return null
    }
  }

  private getStoredSupabaseRefreshToken(): string | null {
    const stored = this.db.getSetting(KEYS.SUPABASE_REFRESH_TOKEN)
    if (!stored) return null
    try {
      return decryptValue(stored)
    } catch {
      return null
    }
  }

  private storeJwt(token: string, expiresInSeconds: number): void {
    this.db.setSetting(KEYS.JWT, encryptValue(token))
    const expiresAt = Date.now() + expiresInSeconds * 1000
    this.db.setSetting(KEYS.JWT_EXPIRES_AT, expiresAt.toString())

    // Update cache
    this.cachedJwt = token
    this.cachedJwtExpiresAt = expiresAt
  }

  private getStoredJwt(): string | null {
    // Check cache first
    if (this.cachedJwt && this.cachedJwtExpiresAt > Date.now() + 300_000) {
      return this.cachedJwt
    }

    const stored = this.db.getSetting(KEYS.JWT)
    if (!stored) return null

    const expiresAtStr = this.db.getSetting(KEYS.JWT_EXPIRES_AT)
    if (expiresAtStr) {
      const expiresAt = parseInt(expiresAtStr, 10)
      // Return null if expired or expiring within 5 minutes
      if (Date.now() >= expiresAt - 300_000) {
        return null
      }
      this.cachedJwtExpiresAt = expiresAt
    }

    try {
      const jwt = decryptValue(stored)
      this.cachedJwt = jwt
      return jwt
    } catch {
      return null
    }
  }

  private async getValidJwt(): Promise<string> {
    let jwt = this.getStoredJwt()
    if (jwt) return jwt

    // JWT is expired or missing — try to refresh
    const result = await this.refreshToken()
    jwt = result.token
    if (!jwt) {
      throw new Error('Failed to obtain a valid token — please sign in again')
    }
    return jwt
  }

  private clearStoredData(): void {
    this.cachedJwt = null
    this.cachedJwtExpiresAt = 0

    for (const key of Object.values(KEYS)) {
      this.db.deleteSetting(key)
    }
  }
}
