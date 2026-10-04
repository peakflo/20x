import { describe, it, expect, vi, beforeEach } from 'vitest'

const files = new Map<string, string>()
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: (path: string) => files.has(path),
    readFileSync: (path: string) => {
      const content = files.get(path)
      if (content === undefined) throw new Error('ENOENT')
      return content
    }
  }
})

import { cursorAuthFilePath, probeCursorUsageLimits, resolveCursorAuthToken } from './cursor-limits'

beforeEach(() => files.clear())

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('Cursor plan limits', () => {
  it('prefers CURSOR_AUTH_TOKEN, then the CLI auth file', async () => {
    expect(await resolveCursorAuthToken({ allowKeychain: false, platform: 'linux', env: { CURSOR_AUTH_TOKEN: ' tok ' } }))
      .toEqual({ token: 'tok', keychainAvailable: false })

    files.set(cursorAuthFilePath('linux', { XDG_CONFIG_HOME: '/cfg' }), JSON.stringify({ accessToken: 'file-token' }))
    expect(await resolveCursorAuthToken({ allowKeychain: false, platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg' } }))
      .toEqual({ token: 'file-token', keychainAvailable: false })
  })

  it('never reads the macOS Keychain without consent and offers an action instead', async () => {
    const readKeychain = vi.fn(async () => 'kc-token')
    const limits = await probeCursorUsageLimits({ allowKeychain: false, platform: 'darwin', env: {}, readKeychain })
    expect(readKeychain).not.toHaveBeenCalled()
    expect(limits?.action).toEqual({ id: 'enable-cursor-keychain', label: 'Allow Keychain access' })
  })

  it('reads the Keychain once allowed and maps the response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { planUsage: { totalPercentUsed: 30 }, billingCycleEnd: 1_789_876_386_000 }))
    const limits = await probeCursorUsageLimits({
      allowKeychain: true,
      platform: 'darwin',
      env: {},
      readKeychain: async () => 'kc-token',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer kc-token', 'connect-protocol-version': '1' })
      })
    )
    expect(limits?.windows).toEqual([expect.objectContaining({ id: 'total', usedPercent: 30 })])
  })

  it('returns null on Linux/Windows without a CLI login (limits do not apply)', async () => {
    expect(await probeCursorUsageLimits({ allowKeychain: false, platform: 'linux', env: {} })).toBeNull()
  })

  it('reports a rejected login and failed requests', async () => {
    const rejected = await probeCursorUsageLimits({
      allowKeychain: false, platform: 'linux', env: { CURSOR_AUTH_TOKEN: 't' },
      fetchImpl: (async () => jsonResponse(401, {})) as unknown as typeof fetch
    })
    expect(rejected?.unavailable?.reason).toBe('unsupported')
    const failed = await probeCursorUsageLimits({
      allowKeychain: false, platform: 'linux', env: { CURSOR_AUTH_TOKEN: 't' },
      fetchImpl: (async () => jsonResponse(500, {})) as unknown as typeof fetch
    })
    expect(failed?.unavailable).toEqual({ reason: 'probe_failed', message: 'Cursor usage request failed (HTTP 500)' })
  })
})
