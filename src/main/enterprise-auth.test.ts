import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { EnterpriseAuth } from './enterprise-auth'

const authMock = {
  signOut: vi.fn(async () => ({})),
  refreshSession: vi.fn(async (): Promise<{
    data: { session: { access_token: string; refresh_token: string } | null }
    error: { message: string; status?: number } | null
  }> => ({ data: { session: null }, error: null })),
  signInWithPassword: vi.fn(async () => ({ data: null, error: null }))
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: authMock
  }))
}))

class MockDb {
  private settings = new Map<string, string>()

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null
  }

  setSetting(key: string, value: string): void {
    this.settings.set(key, value)
  }

  deleteSetting(key: string): void {
    this.settings.delete(key)
  }
}

describe('EnterpriseAuth logging', () => {
  let db: MockDb
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    db = new MockDb()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({})
    })))

    authMock.signOut.mockResolvedValue({})
    authMock.refreshSession.mockResolvedValue({ data: { session: null }, error: null })
  })

  afterEach(() => {
    warnSpy.mockRestore()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('logs reason for manual logout with domain', async () => {
    const auth = new EnterpriseAuth(db as never)
    await auth.logout()

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('auth_logout_manual')
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('auth_state_cleared')
    )
    // Domain should be included in log messages
    const logoutCall = warnSpy.mock.calls.find((c) => c[0].includes('auth_logout_manual'))
    expect(logoutCall?.[0]).toMatch(/\(domain: .+\)/)
  })

  it('logs reason when refresh token is missing and credentials are cleared', async () => {
    const auth = new EnterpriseAuth(db as never)

    await expect(auth.refreshToken()).rejects.toThrow('No refresh token available')

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('auth_clear_missing_refresh_token')
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('auth_state_cleared')
    )
  })

  it('logs reason when supabase refresh fails', async () => {
    db.setSetting('enterprise_supabase_refresh_token', Buffer.from('refresh-token', 'utf8').toString('base64'))
    authMock.refreshSession.mockResolvedValue({
      data: { session: null },
      error: { message: 'Invalid Refresh Token: Refresh Token Not Found', status: 400 }
    })

    const auth = new EnterpriseAuth(db as never)

    await expect(auth.refreshToken()).rejects.toThrow('Session expired')

    expect(
      warnSpy.mock.calls.some((call) => call[0].includes('auth_clear_supabase_refresh_failed'))
    ).toBe(true)
  })

  it('deduplicates concurrent refresh calls (prevents race condition)', async () => {
    // Seed a stored refresh token so refreshToken() gets past the guard
    db.setSetting('enterprise_supabase_refresh_token', Buffer.from('refresh-tok', 'utf8').toString('base64'))
    db.setSetting('enterprise_tenant_id', 'tenant-1')

    let resolveRefresh: ((v: { data: unknown; error: null }) => void) | null = null
    authMock.refreshSession.mockImplementation(
      () => new Promise((r) => { resolveRefresh = r as never })
    )

    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: 'jwt-new', expiresIn: 3600 })
    }))
    vi.stubGlobal('fetch', fetchFn)

    const auth = new EnterpriseAuth(db as never)

    // Fire two concurrent refreshes
    const p1 = auth.refreshToken()
    const p2 = auth.refreshToken()

    // Supabase should only have been called ONCE (dedup)
    expect(authMock.refreshSession).toHaveBeenCalledTimes(1)

    // Resolve the single in-flight refresh
    resolveRefresh!({
      data: {
        session: {
          access_token: 'new-access',
          refresh_token: 'new-refresh'
        }
      },
      error: null
    })

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.token).toBe('jwt-new')
    expect(r2.token).toBe('jwt-new')

    // Still only one Supabase call
    expect(authMock.refreshSession).toHaveBeenCalledTimes(1)
  })

  it('allows a new refresh after the previous one completes', async () => {
    db.setSetting('enterprise_supabase_refresh_token', Buffer.from('refresh-tok', 'utf8').toString('base64'))
    db.setSetting('enterprise_tenant_id', 'tenant-1')

    authMock.refreshSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'access-1',
          refresh_token: 'refresh-1'
        }
      },
      error: null
    })

    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: 'jwt-tok', expiresIn: 3600 })
    }))
    vi.stubGlobal('fetch', fetchFn)

    const auth = new EnterpriseAuth(db as never)

    // First refresh completes
    await auth.refreshToken()
    expect(authMock.refreshSession).toHaveBeenCalledTimes(1)

    // Second refresh should start a NEW call (not reuse the completed promise)
    await auth.refreshToken()
    expect(authMock.refreshSession).toHaveBeenCalledTimes(2)
  })

  it('concurrent callers all receive the error when refresh fails', async () => {
    // No refresh token stored → immediate failure
    const auth = new EnterpriseAuth(db as never)

    const p1 = auth.refreshToken()
    const p2 = auth.refreshToken()

    await expect(p1).rejects.toThrow('No refresh token available')
    await expect(p2).rejects.toThrow('No refresh token available')
  })

  it('getDomain() returns hostname from configured API URL', () => {
    const auth = new EnterpriseAuth(db as never)
    const domain = auth.getDomain()
    // Returns a valid hostname (varies by env config: localhost, stage-api.peakflo.ai, etc.)
    expect(domain).toBeTruthy()
    expect(typeof domain).toBe('string')
    expect(domain.length).toBeGreaterThan(0)
  })

  it('includes domain in all logAuthEvent messages', async () => {
    const auth = new EnterpriseAuth(db as never)
    await auth.logout()

    // Every warn call should include "(domain: ...)"
    for (const call of warnSpy.mock.calls) {
      if (call[0].startsWith('[EnterpriseAuth]')) {
        expect(call[0]).toMatch(/\(domain: .+\)/)
      }
    }
  })

  it('logs reason when API request 401 retry path ends in auth clear', async () => {
    db.setSetting('enterprise_jwt', Buffer.from('jwt-token', 'utf8').toString('base64'))
    // Keep JWT valid beyond the 5-minute early-refresh window so apiRequest()
    // uses it first, receives 401, and enters the retry/clear branch.
    db.setSetting('enterprise_jwt_expires_at', String(Date.now() + 10 * 60_000))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Unauthorized' })
    })))

    const auth = new EnterpriseAuth(db as never)

    await expect(auth.apiRequest('GET', '/api/test')).rejects.toThrow('Session expired')

    expect(
      warnSpy.mock.calls.some((call) => call[0].includes('auth_clear_after_api_401_retry_failed'))
    ).toBe(true)
  })

  it('includes domain in API error logs for 403 responses', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    db.setSetting('enterprise_jwt', Buffer.from('jwt-token', 'utf8').toString('base64'))
    db.setSetting('enterprise_jwt_expires_at', String(Date.now() + 10 * 60_000))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ message: 'Forbidden', details: { role: 'viewer' } })
    })))

    const auth = new EnterpriseAuth(db as never)

    await expect(auth.apiRequest('GET', '/api/nodes')).rejects.toThrow('Forbidden')

    const errCall = errorSpy.mock.calls.find((c) =>
      c[0].includes('[EnterpriseAuth] Permission denied')
    )
    expect(errCall).toBeDefined()
    expect(errCall![0]).toMatch(/\(domain: .+\)/)

    errorSpy.mockRestore()
  })

  it('includes domain in API error logs for non-ok responses', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    db.setSetting('enterprise_jwt', Buffer.from('jwt-token', 'utf8').toString('base64'))
    db.setSetting('enterprise_jwt_expires_at', String(Date.now() + 10 * 60_000))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ message: 'Internal Server Error' })
    })))

    const auth = new EnterpriseAuth(db as never)

    await expect(auth.apiRequest('POST', '/api/skills')).rejects.toThrow('Internal Server Error')

    const errCall = errorSpy.mock.calls.find((c) =>
      c[0].includes('[EnterpriseAuth] API error')
    )
    expect(errCall).toBeDefined()
    expect(errCall![0]).toMatch(/\(domain: .+\)/)
    expect(errCall![0]).toContain('500')

    errorSpy.mockRestore()
  })
})
