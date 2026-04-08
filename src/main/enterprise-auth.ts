import { app, safeStorage } from 'electron'
import { createClient, SupabaseClient, Session } from '@supabase/supabase-js'
import type { DatabaseManager } from './database'

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
        persistSession: false
      }
    })
  }

  getApiUrl(): string {
    return this.apiUrl
  }

  async getJwt(): Promise<string> {
    return this.getValidJwt()
  }

  // ── Login (email/password via Supabase) ───────────────────────────

  async login(email: string, password: string): Promise<EnterpriseLoginResult> {
    if (!email || !password) {
      throw new Error('Email and password are required')
    }

    // Sign in with Supabase
    const { data, error } = await this.supabase.auth.signInWithPassword({
      email,
      password
    })

    if (error) {
      throw new Error(error.message)
    }

    if (!data.session || !data.user) {
      throw new Error('Authentication failed — no session returned')
    }

    // Store Supabase tokens (encrypted)
    this.storeSupabaseSession(data.session)

    // Store basic user info
    this.db.setSetting(KEYS.USER_EMAIL, data.user.email || email)
    this.db.setSetting(KEYS.USER_ID, data.user.id)

    // Fetch user's companies from the workflow-api
    const companies = await this.fetchCompanies(data.session.access_token)

    return {
      userId: data.user.id,
      email: data.user.email || email,
      companies
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
    this.logAuthEvent('auth_logout_manual')

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

  // ── Get Auth Tokens (for deep-linking into workflow-builder) ─────

  async getAuthTokens(): Promise<{
    accessToken: string
    refreshToken: string
    tenantId: string | null
  }> {
    const accessToken = this.getStoredSupabaseAccessToken()
    const refreshToken = this.getStoredSupabaseRefreshToken()
    if (!accessToken || !refreshToken) {
      throw new Error('Not authenticated — please sign in first')
    }
    const tenantId = this.db.getSetting(KEYS.TENANT_ID) ?? null
    return { accessToken, refreshToken, tenantId }
  }

  // ── Refresh Token ────────────────────────────────────────────────

  async refreshToken(): Promise<{ token: string }> {
    // First refresh the Supabase session
    const refreshToken = this.getStoredSupabaseRefreshToken()
    if (!refreshToken) {
      this.logAuthEvent('auth_clear_missing_refresh_token')
      this.clearStoredData()
      throw new Error('No refresh token available — please sign in again')
    }

    const { data, error } = await this.supabase.auth.refreshSession({
      refresh_token: refreshToken
    })

    if (error || !data.session) {
      this.logAuthEvent('auth_clear_supabase_refresh_failed', {
        message: error?.message || 'No session returned',
        status: (error as { status?: number } | null)?.status
      })
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
      } catch (error) {
        this.logAuthEvent('auth_clear_after_api_401_retry_failed', {
          method: method.toUpperCase(),
          path,
          error: this.describeError(error)
        })
        this.clearStoredData()
        throw new Error('Session expired — please sign in again')
      }
    }

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}))
      console.error(`[EnterpriseAuth] API error ${response.status} ${method} ${path}:`, JSON.stringify(errorBody))
      const detail = errorBody.details ? ` ${JSON.stringify(errorBody.details)}` : ''
      throw new Error(errorBody.message || errorBody.error || `API request failed (${response.status})${detail}`)
    }

    return response.json().catch(() => null)
  }

  /**
   * Download a binary file from the API (returns Buffer instead of JSON).
   */
  async downloadFile(path: string): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
    const jwt = await this.getValidJwt()

    const url = `${this.apiUrl}${path.startsWith('/') ? path : `/${path}`}`

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${jwt}`
    }

    let response = await fetch(url, { method: 'GET', headers })

    if (response.status === 401) {
      try {
        await this.refreshToken()
        const retryJwt = await this.getValidJwt()
        headers['Authorization'] = `Bearer ${retryJwt}`
        response = await fetch(url, { method: 'GET', headers })
      } catch (error) {
        this.logAuthEvent('auth_clear_after_download_401_retry_failed', {
          path,
          error: this.describeError(error)
        })
        this.clearStoredData()
        throw new Error('Session expired — please sign in again')
      }
    }

    if (!response.ok) {
      throw new Error(`File download failed (${response.status})`)
    }

    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    // Extract filename from Content-Disposition header
    const disposition = response.headers.get('content-disposition') || ''
    const filenameMatch = disposition.match(/filename\*?=(?:UTF-8'')?([^;\s]+)/i) ||
                          disposition.match(/filename="?([^";\s]+)"?/i)
    const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : path.split('/').pop() || 'file'

    const contentType = response.headers.get('content-type') || 'application/octet-stream'

    return { buffer, filename, contentType }
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
    this.logAuthEvent('auth_state_cleared')
    this.cachedJwt = null
    this.cachedJwtExpiresAt = 0

    for (const key of Object.values(KEYS)) {
      this.db.deleteSetting(key)
    }
  }

  private logAuthEvent(event: string, details?: Record<string, unknown>): void {
    if (details) {
      console.warn(`[EnterpriseAuth] ${event} ${JSON.stringify(details)}`)
      return
    }
    console.warn(`[EnterpriseAuth] ${event}`)
  }

  private describeError(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
      return { name: error.name, message: error.message }
    }
    if (typeof error === 'object' && error !== null) {
      return { raw: String(error) }
    }
    return { raw: String(error) }
  }
}
