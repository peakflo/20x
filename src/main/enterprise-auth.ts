import { app, safeStorage, Notification } from 'electron'
import { createClient, SupabaseClient, Session } from '@supabase/supabase-js'
import type { DatabaseManager } from './database'
import {
  clearEnterpriseAiGatewayConfig,
  storeEnterpriseAiGatewayConfig
} from './enterprise-ai-gateway'

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
  /** Non-fatal warnings from post-auth setup (e.g. AI gateway key fetch failure). */
  warnings?: string[]
}

export interface EnterpriseSession {
  isAuthenticated: boolean
  userEmail: string | null
  userId: string | null
  currentTenant: { id: string; name: string } | null
}

/**
 * Thrown when the enterprise session is *definitively* invalid and the user
 * must sign in again (e.g. the Supabase refresh token was rejected with
 * invalid_grant / refresh_token_not_found). Distinct from transient
 * network/5xx failures, which must NOT invalidate the stored session.
 *
 * When this error is thrown, stored credentials have already been cleared.
 */
export class EnterpriseAuthInvalidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnterpriseAuthInvalidError'
  }
}

/** Minimal shape of a Supabase refresh error we inspect for classification. */
type RefreshErrorLike = { message?: string; status?: number; code?: string; name?: string } | null

interface EnterpriseAiGatewayVirtualKeyResponse {
  apiKey: string
  baseUrl: string
  keyName?: string | null
  expiresAt?: string | null
}

interface EnterpriseAiGatewayModelsResponse {
  data?: Array<{
    id?: string
    model_name?: string
  }>
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

  // Mutex: in-flight refresh promise to prevent concurrent refresh races
  private refreshInFlight: Promise<{ token: string }> | null = null

  // Dedup: only notify user once per app run when session expires involuntarily
  private notifiedSessionExpired = false

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

  /**
   * Extract the domain (hostname) from the configured API URL.
   * Used in error/warning logs so operators can identify which
   * enterprise cloud instance produced the error.
   */
  getDomain(): string {
    try {
      return new URL(this.apiUrl).hostname
    } catch {
      return this.apiUrl
    }
  }

  async getJwt(): Promise<string> {
    return this.getValidJwt()
  }

  // ── Login with raw Supabase tokens (from browser signup/login callback) ───

  async loginWithTokens(accessToken: string, refreshToken: string): Promise<EnterpriseLoginResult> {
    // Set the session in Supabase client so it can be used for refresh later
    const { data, error } = await this.supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken
    })

    if (error) {
      throw new Error(error.message)
    }

    if (!data.session || !data.user) {
      throw new Error('Authentication failed — invalid tokens')
    }

    // Store Supabase tokens (encrypted)
    this.storeSupabaseSession(data.session)

    // Store basic user info
    this.db.setSetting(KEYS.USER_EMAIL, data.user.email || '')
    this.db.setSetting(KEYS.USER_ID, data.user.id)

    // Fetch user's companies from the workflow-api
    const companies = await this.fetchCompanies(data.session.access_token)

    return {
      userId: data.user.id,
      email: data.user.email || '',
      companies
    }
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

    this.logAuthEvent('auth_select_tenant_start', { tenantId })

    // Prefer the stored Supabase access token. If it's missing (e.g. it was
    // rotated/expired since login), attempt to restore it from the refresh
    // token before giving up — this prevents the spurious
    // "Not authenticated — please sign in first" error when the user actually
    // still holds a valid refresh token.
    let accessToken = this.getStoredSupabaseAccessToken()
    if (!accessToken) {
      accessToken = await this.tryRefreshSupabaseAccessToken()
    }
    if (!accessToken) {
      this.logAuthEvent('auth_select_tenant_not_authenticated')
      throw new Error('Not authenticated — please sign in first')
    }

    const doSelect = (token: string): Promise<Response> =>
      fetch(`${this.apiUrl}/api/20x/auth/select-tenant`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ tenantId })
      })

    let response = await doSelect(accessToken)

    // The stored access token may have expired between login and selection.
    // Refresh the Supabase session once and retry before surfacing an error.
    if (response.status === 401) {
      this.logAuthEvent('auth_select_tenant_access_token_expired')
      const refreshed = await this.tryRefreshSupabaseAccessToken()
      if (refreshed) {
        accessToken = refreshed
        response = await doSelect(accessToken)
      }
    }

    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      this.logAuthEvent('auth_select_tenant_failed', {
        status: response.status,
        message: body.message ?? null
      })
      throw new Error(body.message || `Failed to select tenant (${response.status})`)
    }

    const result = await response.json()

    // Store JWT (encrypted) and tenant info
    this.storeJwt(result.token, result.expiresIn)
    this.db.setSetting(KEYS.TENANT_ID, result.tenant.id)
    this.db.setSetting(KEYS.TENANT_NAME, result.tenant.name)
    this.logAuthEvent('auth_select_tenant_success', {
      tenantId: result.tenant.id,
      tenantName: result.tenant.name
    })
    const warnings: string[] = []
    try {
      this.logAuthEvent('ai_gateway_virtual_key_fetch_start')
      await this.fetchAndStoreAiGatewayVirtualKey()
    } catch (err) {
      this.logAuthEvent('ai_gateway_virtual_key_fetch_error', this.describeError(err))
      const msg = err instanceof Error ? err.message : String(err)
      warnings.push(`AI Gateway models unavailable: ${msg}`)
    }

    return {
      token: result.token,
      tenant: result.tenant,
      ...(warnings.length > 0 ? { warnings } : {})
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
    // Deduplicate concurrent refresh calls: if a refresh is already
    // in-flight, all callers share the same promise instead of racing
    // and accidentally rotating the Supabase refresh token out from
    // under each other (which causes auth_clear_missing_refresh_token).
    if (this.refreshInFlight) {
      return this.refreshInFlight
    }

    this.refreshInFlight = this.executeRefresh().finally(() => {
      this.refreshInFlight = null
    })

    return this.refreshInFlight
  }

  private async executeRefresh(): Promise<{ token: string }> {
    // First refresh the Supabase session. This clears stored data ONLY when
    // the refresh token is definitively invalid — transient network/5xx
    // failures throw without wiping the session so the user stays signed in.
    const accessToken = await this.refreshSupabaseSession()

    // Now refresh the pf-workflo JWT
    const tenantId = this.db.getSetting(KEYS.TENANT_ID)
    if (!tenantId) {
      throw new Error('No tenant selected — please select an organization')
    }

    const response = await fetch(`${this.apiUrl}/api/20x/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
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

  /**
   * Refresh the underlying Supabase session using the stored refresh token and
   * return the fresh access token.
   *
   * Credential-clearing policy:
   * - Missing refresh token          → clear + throw EnterpriseAuthInvalidError
   * - Refresh rejected (invalid_grant / 400/401 / refresh token not found)
   *                                   → clear + throw EnterpriseAuthInvalidError
   * - Transient failure (network / timeout / 5xx / 408 / 429 / unknown)
   *                                   → KEEP session, throw plain Error
   *
   * This is the single choke-point that decides whether an involuntary
   * sign-out happens, which is what prevented premature logouts on flaky
   * networks.
   */
  private async refreshSupabaseSession(): Promise<string> {
    const refreshToken = this.getStoredSupabaseRefreshToken()
    if (!refreshToken) {
      this.logAuthEvent('auth_clear_missing_refresh_token')
      this.clearStoredData()
      this.notifySessionExpired('No refresh token — please sign in to 20x Cloud again.')
      throw new EnterpriseAuthInvalidError('No refresh token available — please sign in again')
    }

    let session: Session | null = null
    let error: RefreshErrorLike = null
    try {
      const result = await this.supabase.auth.refreshSession({ refresh_token: refreshToken })
      session = result.data.session
      error = result.error as RefreshErrorLike
    } catch (err) {
      // A thrown error (rather than a returned { error }) is almost always a
      // network/transport failure — treat as transient, do NOT clear.
      this.logAuthEvent('auth_refresh_transient_skip_clear', {
        reason: 'refresh_session_threw',
        ...this.describeError(err)
      })
      throw new Error('Unable to reach 20x Cloud to refresh the session — please try again')
    }

    if (error || !session) {
      const classification = this.classifyRefreshError(error)
      if (classification === 'invalid') {
        this.logAuthEvent('auth_clear_supabase_refresh_failed', {
          message: error?.message || 'No session returned',
          status: error?.status,
          code: error?.code
        })
        this.clearStoredData()
        this.notifySessionExpired('Session expired — please sign in to 20x Cloud again.')
        throw new EnterpriseAuthInvalidError('Session expired — please sign in again')
      }

      // Transient: keep the stored session intact so a later retry can succeed.
      this.logAuthEvent('auth_refresh_transient_skip_clear', {
        message: error?.message || 'No session returned',
        status: error?.status,
        code: error?.code
      })
      throw new Error('Unable to reach 20x Cloud to refresh the session — please try again')
    }

    // Store updated Supabase tokens
    this.storeSupabaseSession(session)
    return session.access_token
  }

  /**
   * Best-effort variant of refreshSupabaseSession used by selectTenant.
   * Returns the fresh access token, or null if the session could not be
   * restored (whether the failure was definitive or transient — the caller
   * decides how to surface it). Definitive failures still clear credentials
   * inside refreshSupabaseSession.
   */
  private async tryRefreshSupabaseAccessToken(): Promise<string | null> {
    try {
      return await this.refreshSupabaseSession()
    } catch (err) {
      this.logAuthEvent('auth_supabase_restore_failed', this.describeError(err))
      return null
    }
  }

  /**
   * Classify a Supabase refresh error as a definitive auth failure ('invalid',
   * requiring re-login) or a recoverable/transient one ('transient', keep the
   * session). The default for ambiguous cases is 'transient' so we never sign a
   * user out on an error we don't positively recognise as auth-invalid.
   */
  private classifyRefreshError(error: RefreshErrorLike): 'invalid' | 'transient' {
    // No structured error but no session either — ambiguous; don't clear.
    if (!error) return 'transient'

    const status = typeof error.status === 'number' ? error.status : undefined
    const code = (error.code || '').toLowerCase()
    const message = (error.message || '').toLowerCase()
    const name = (error.name || '').toLowerCase()

    // Definitive auth-invalid signals: the refresh token itself is bad.
    const invalidCodes = [
      'invalid_grant',
      'refresh_token_not_found',
      'refresh_token_already_used',
      'session_not_found',
      'session_expired',
      'bad_jwt'
    ]
    if (invalidCodes.includes(code)) return 'invalid'
    if (
      /invalid refresh token|refresh token not found|already used|invalid_grant|invalid token|session (?:not found|expired)|jwt expired/.test(
        message
      )
    ) {
      return 'invalid'
    }

    // Transient signals: network / server errors → keep the session.
    if (name.includes('retryable') || name.includes('fetch')) return 'transient'
    if (
      /fetch failed|failed to fetch|network|timeout|timed out|econn|enotfound|eai_again|socket|temporar|unavailable|502|503|504/.test(
        message
      )
    ) {
      return 'transient'
    }
    if (status !== undefined) {
      if (status >= 500 || status === 408 || status === 429 || status === 0) return 'transient'
      // Explicit auth-rejection status codes from the refresh endpoint.
      if (status === 400 || status === 401 || status === 403 || status === 422) return 'invalid'
    }

    // Unknown shape → be conservative and keep the session.
    return 'transient'
  }

  // ── API Request Proxy ────────────────────────────────────────────

  async apiRequest(method: string, path: string, body?: unknown): Promise<unknown> {
    const jwt = await this.getValidJwt()

    const url = `${this.apiUrl}${path.startsWith('/') ? path : `/${path}`}`
    const normalizedMethod = method.toUpperCase()

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${jwt}`
    }

    const fetchOptions: RequestInit = {
      method: normalizedMethod,
      headers
    }

    if (body !== undefined && normalizedMethod !== 'GET') {
      headers['Content-Type'] = 'application/json'
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
          // We just proved the session is valid by refreshing it successfully.
          // A non-ok here (even another 401) is therefore a RESOURCE-level
          // rejection specific to this endpoint (e.g. an AI-gateway virtual key
          // that isn't provisioned) — NOT an invalid session. Surface the
          // resource error WITHOUT clearing credentials, otherwise an optional
          // post-auth call (like the AI-gateway key fetch inside selectTenant)
          // would wipe the freshly-established session.
          const retryBody = await retryResponse.json().catch(() => ({}))
          this.logAuthEvent('auth_api_401_retry_resource_error', {
            method: normalizedMethod,
            path,
            status: retryResponse.status
          })
          throw new Error(retryBody.message || `API request failed (${retryResponse.status})`)
        }

        return retryResponse.json().catch(() => null)
      } catch (error) {
        // Only clear credentials when the refresh itself proved the session is
        // DEFINITIVELY invalid. Transient network/5xx failures and
        // resource-level rejections must NOT sign the user out.
        if (error instanceof EnterpriseAuthInvalidError) {
          this.logAuthEvent('auth_clear_after_api_401_retry_failed', {
            method: normalizedMethod,
            path,
            error: this.describeError(error)
          })
          this.clearStoredData()
          throw new Error('Session expired — please sign in again')
        }
        this.logAuthEvent('auth_api_401_retry_no_clear', {
          method: normalizedMethod,
          path,
          error: this.describeError(error)
        })
        throw error instanceof Error ? error : new Error(String(error))
      }
    }

    if (response.status === 403) {
      const errorBody = await response.json().catch(() => ({}))
      console.error(`[EnterpriseAuth] Permission denied ${method} ${path} (domain: ${this.getDomain()}):`, JSON.stringify(errorBody))
      // Include diagnostic details from the server so users/developers
      // can understand WHY permission was denied (e.g. missing role)
      const details = errorBody.details ? ` (${JSON.stringify(errorBody.details)})` : ''
      throw new Error(errorBody.message || errorBody.error || `Permission denied (${response.status})${details}`)
    }

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}))
      console.error(`[EnterpriseAuth] API error ${response.status} ${method} ${path} (domain: ${this.getDomain()}):`, JSON.stringify(errorBody))
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
        // Only clear credentials on a definitive auth failure — transient
        // network/5xx errors must not sign the user out.
        if (error instanceof EnterpriseAuthInvalidError) {
          this.logAuthEvent('auth_clear_after_download_401_retry_failed', {
            path,
            error: this.describeError(error)
          })
          this.clearStoredData()
          throw new Error('Session expired — please sign in again')
        }
        this.logAuthEvent('auth_download_401_retry_transient', {
          path,
          error: this.describeError(error)
        })
        throw error instanceof Error ? error : new Error(String(error))
      }
    }

    if (!response.ok) {
      console.error(`[EnterpriseAuth] File download failed ${response.status} ${path} (domain: ${this.getDomain()})`)
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

  // ── List Companies (using existing session) ─────────────────────

  /**
   * Fetch the user's available companies using the stored Supabase access token.
   * Does NOT require re-authentication — reuses the existing session.
   * Refreshes the token first if needed.
   */
  async listCompanies(): Promise<EnterpriseCompany[]> {
    // Try refreshing the token first to ensure it's still valid
    let accessToken = this.getStoredSupabaseAccessToken()
    if (!accessToken) {
      throw new Error('Not authenticated — please sign in first')
    }

    try {
      return await this.fetchCompanies(accessToken)
    } catch {
      // Token may be expired — try refreshing
      try {
        await this.refreshToken()
        // refreshToken stores the new tokens; re-read from storage
        accessToken = this.getStoredSupabaseAccessToken()
        if (!accessToken) throw new Error('Token refresh failed')
        return await this.fetchCompanies(accessToken)
      } catch {
        throw new Error('Session expired — please sign in again')
      }
    }
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

  /**
   * Re-fetch and store the AI gateway virtual key from the backend.
   * Exposed publicly so callers (e.g. IPC handlers, adapter error recovery)
   * can trigger a key refresh when LiteLLM returns "Invalid proxy server token".
   */
  async refreshAiGatewayVirtualKey(): Promise<void> {
    return this.fetchAndStoreAiGatewayVirtualKey()
  }

  private async fetchAndStoreAiGatewayVirtualKey(): Promise<void> {
    const result = await this.apiRequest('GET', '/api/20x/ai-gateway/virtual-key') as EnterpriseAiGatewayVirtualKeyResponse

    if (!result?.apiKey || !result?.baseUrl) {
      throw new Error('Failed to fetch AI gateway virtual key')
    }

    this.logAuthEvent('ai_gateway_virtual_key_received', {
      baseUrl: result.baseUrl,
      keyName: result.keyName ?? null,
      expiresAt: result.expiresAt ?? null,
      hasApiKey: !!result.apiKey
    })

    const models = await this.fetchAiGatewayModels(result)

    this.logAuthEvent('ai_gateway_models_stored', {
      modelCount: models.length,
      modelIds: models.map((m) => m.id)
    })

    storeEnterpriseAiGatewayConfig(this.db, {
      apiKey: result.apiKey,
      baseUrl: result.baseUrl,
      keyName: result.keyName ?? null,
      expiresAt: result.expiresAt ?? null,
      models
    })
  }

  private async fetchAiGatewayModels(
    config: EnterpriseAiGatewayVirtualKeyResponse
  ): Promise<Array<{ id: string; name: string }>> {
    const url = `${config.baseUrl}/models`
    this.logAuthEvent('ai_gateway_models_fetch_start', { url })

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.apiKey}`
      }
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '<unreadable>')
      this.logAuthEvent('ai_gateway_models_fetch_failed', {
        status: response.status,
        body: errorText.slice(0, 500)
      })
      throw new Error(`Failed to fetch AI gateway models (${response.status})`)
    }

    const result = await response.json() as EnterpriseAiGatewayModelsResponse

    this.logAuthEvent('ai_gateway_models_raw_response', {
      dataLength: Array.isArray(result.data) ? result.data.length : 0,
      rawModels: (Array.isArray(result.data) ? result.data : []).map((m) => ({
        id: m.id,
        model_name: m.model_name
      }))
    })

    const models = Array.isArray(result.data) ? result.data : []

    return models
      .map((model) => {
        const id = model.id || model.model_name
        if (!id) return null
        return {
          id,
          name: model.model_name || id
        }
      })
      .filter((model): model is { id: string; name: string } => model !== null)
  }

  private clearStoredData(): void {
    this.logAuthEvent('auth_state_cleared')
    this.cachedJwt = null
    this.cachedJwtExpiresAt = 0
    clearEnterpriseAiGatewayConfig(this.db)

    for (const key of Object.values(KEYS)) {
      this.db.deleteSetting(key)
    }
  }

  /**
   * Show an OS notification when enterprise auth is involuntarily invalidated.
   * Fires at most once per app run to avoid spamming.
   */
  private notifySessionExpired(body: string): void {
    if (this.notifiedSessionExpired) return
    this.notifiedSessionExpired = true
    try {
      new Notification({
        title: '20x Cloud Disconnected',
        body
      }).show()
    } catch {
      // Notification may fail in headless / test environments — ignore
    }
  }

  private logAuthEvent(event: string, details?: Record<string, unknown>): void {
    const domain = this.getDomain()
    if (details) {
      console.warn(`[EnterpriseAuth] ${event} (domain: ${domain}) ${JSON.stringify(details)}`)
      return
    }
    console.warn(`[EnterpriseAuth] ${event} (domain: ${domain})`)
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
