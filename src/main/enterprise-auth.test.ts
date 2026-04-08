import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { EnterpriseAuth } from './enterprise-auth'

const authMock = {
  signOut: vi.fn(async () => ({})),
  refreshSession: vi.fn(async (): Promise<{
    data: { session: null }
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

  it('logs reason for manual logout', async () => {
    const auth = new EnterpriseAuth(db as never)
    await auth.logout()

    expect(warnSpy).toHaveBeenCalledWith('[EnterpriseAuth] auth_logout_manual')
    expect(warnSpy).toHaveBeenCalledWith('[EnterpriseAuth] auth_state_cleared')
  })

  it('logs reason when refresh token is missing and credentials are cleared', async () => {
    const auth = new EnterpriseAuth(db as never)

    await expect(auth.refreshToken()).rejects.toThrow('No refresh token available')

    expect(warnSpy).toHaveBeenCalledWith('[EnterpriseAuth] auth_clear_missing_refresh_token')
    expect(warnSpy).toHaveBeenCalledWith('[EnterpriseAuth] auth_state_cleared')
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
})
