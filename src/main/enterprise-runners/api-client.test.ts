import { describe, expect, it, vi } from 'vitest'
import { EnterpriseRunnersApi, toFailure } from './api-client'
import { runPreflight } from './preflight'

const ID = '3f6c2a9e-8b1d-4c7a-9e2f-5d4b1a0c7e63'

function api(handler: (method: string, path: string, body?: unknown) => unknown, signedIn = true) {
  const apiRequest = vi.fn(async (method: string, path: string, body?: unknown) => {
    const result = handler(method, path, body)
    if (result instanceof Error) throw result
    return result
  })
  return { client: new EnterpriseRunnersApi({ apiRequest, getApiUrl: () => 'https://api.peakflo.ai', isSignedIn: async () => signedIn }), apiRequest }
}
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status })

describe('EnterpriseRunnersApi', () => {
  it('creates a connection with discover:true and drops any token in the response', async () => {
    const { client, apiRequest } = api(() => ({ tokenId: ID, expiresAt: '2026-11-23T12:15:00Z', enrolmentToken: 'enrol-secret' }))
    const info = await client.createConnection(['codex'])
    expect(info).toEqual({ connectionId: ID, expiresAt: '2026-11-23T12:15:00Z' })
    expect(JSON.stringify(info)).not.toContain('enrol-secret')
    expect(apiRequest).toHaveBeenCalledWith('POST', '/api/onboarding/byo/tokens', { discover: true, allowed_vendor_backends: ['codex'] })
  })

  it('sends replaces_runner_id on reconnect', async () => {
    const { client, apiRequest } = api(() => ({ tokenId: ID }))
    await client.createConnection(['claude-code', 'codex', 'cursor'], 'r1')
    expect(apiRequest.mock.calls[0][2]).toMatchObject({ replaces_runner_id: 'r1' })
  })

  it('reads the server pin and engines, and ignores a malformed pin', async () => {
    expect(await api(() => ({ version: '1.8.2', channel: 'final', nodeEngines: '^22.23.5' })).client.getHarnessVersion()).toEqual({ version: '1.8.2', nodeEngines: '^22.23.5' })
    expect((await api(() => ({ version: 'latest' })).client.getHarnessVersion()).version).toBeNull()
  })

  it('uses the documented routes for rename, remove and update', async () => {
    const { client, apiRequest } = api(() => ({ ok: true }))
    await client.renameMachine('r1', '  Mac  ')
    await client.removeMachine('r1')
    await client.updateMachine('r1')
    expect(apiRequest.mock.calls).toEqual([
      ['PATCH', '/api/onboarding/byo/machines/r1', { name: 'Mac' }],
      ['DELETE', '/api/onboarding/byo/machines/r1', undefined],
      ['POST', '/api/onboarding/byo/machines/r1/update-now', undefined]
    ])
    expect(await client.renameMachine('r1', '   ')).toMatchObject({ ok: false })
  })

  it('merges machines + runners + pin into one snapshot', async () => {
    const { client } = api((_m, path) => {
      if (path.endsWith('/machines')) return { machines: [{ runnerId: 'm1', name: 'studio-mac', personal: true, isOwner: true, canManage: true, harnessVersion: '1.7.0', registered: true, update: { available: true, targetVersion: '1.8.2' } }] }
      if (path.endsWith('/runners')) return { runners: [{ id: 'm1', name: 'studio-mac', personal: true, canSelect: true, status: 'ready', lastHeartbeatAt: new Date().toISOString() }] }
      return { version: '1.8.2', nodeEngines: null }
    })
    const result = await client.listMachines('studio-mac')
    expect(result.ok && result.snapshot.pinnedVersion).toBe('1.8.2')
    expect(result.ok && result.snapshot.machines[0].versionState.kind).toBe('update_available')
  })

  it('degrades when one list fails, and maps 403 / signed-out / unavailable', async () => {
    const half = api((_m, path) => (path.endsWith('/runners') ? httpError(500, 'boom') : path.endsWith('/machines') ? { machines: [{ runnerId: 'm1', name: 'a', personal: true, isOwner: true, registered: true }] } : { version: null }))
    expect((await half.client.listMachines()).ok).toBe(true)

    const denied = api(() => httpError(403, 'Permission denied'))
    expect(await denied.client.listMachines()).toMatchObject({ ok: false, error: { kind: 'permission_denied' } })
    const out = api(() => ({}), false)
    expect(await out.client.listMachines()).toMatchObject({ ok: false, error: { kind: 'not_signed_in' } })
    const down = api(() => httpError(503, 'unavailable'))
    expect(await down.client.listMachines()).toMatchObject({ ok: false, error: { kind: 'unavailable' } })
    expect(toFailure(new Error('Session expired — please sign in again')).kind).toBe('not_signed_in')
  })
})

describe('runPreflight', () => {
  const ok = { getHarnessVersion: async () => ({ version: '1.8.2', nodeEngines: '^22.23.5 || ^24.22.3 || >=26.13.1 <27' }), getApiUrl: () => 'https://api.peakflo.ai' }
  const tools = { node: '/opt/node/bin/node', npx: '/opt/node/bin/npx', git: '/usr/bin/git', dirs: ['/opt/node/bin', '/usr/bin'] }
  const run = (node: string | null, git: string | null, npx: string | null = '10.9.2') => async (command: string) =>
    command.endsWith('/node')
      ? { ok: node !== null, stdout: node ?? '' }
      : command.endsWith('/npx')
        ? { ok: npx !== null, stdout: npx ?? '' }
        : { ok: git !== null, stdout: git ?? '' }
  const base = { platform: 'darwin' as const, arch: 'arm64', api: ok, isSignedIn: async () => true, toolchain: tools }

  it('passes with OS, Node in range, Git and sign-in', async () => {
    const result = await runPreflight({ ...base, run: run('v22.23.5\n', 'git version 2.45.1') })
    expect(result.ok).toBe(true)
    expect(result.checks.map((c) => [c.id, c.ok])).toEqual([['os', true], ['signed_in', true], ['node', true], ['npx', true], ['git', true]])
    expect(result).toMatchObject({ pinnedVersion: '1.8.2', controlPlane: 'https://api.peakflo.ai' })
  })

  it('fails on Node out of range, with install help', async () => {
    const result = await runPreflight({ ...base, run: run('v22.4.0', 'git version 2.45.1') })
    expect(result.ok).toBe(false)
    expect(result.failure).toMatchObject({ kind: 'node_missing', help: 'brew upgrade node' })
  })

  it('fails on Node or Git missing', async () => {
    expect((await runPreflight({ ...base, run: run(null, 'git version 2.45.1') })).failure?.kind).toBe('node_missing')
    expect((await runPreflight({ ...base, run: run('v22.23.5', null) })).failure).toMatchObject({ kind: 'git_missing', help: 'xcode-select --install' })
  })

  it('fails when Node is present but npx (npm) is not', async () => {
    const result = await runPreflight({ ...base, run: run('v22.23.5', 'git version 2.45.1', null) })
    expect(result.ok).toBe(false)
    expect(result.checks.find((c) => c.id === 'npx')).toMatchObject({ ok: false, help: 'brew reinstall node' })
    expect(result.failure).toMatchObject({ kind: 'node_missing' })
    expect(result.failure?.message).toMatch(/npx/)
    const unresolved = await runPreflight({ ...base, toolchain: { ...tools, npx: null }, run: run('v22.23.5', 'git version 2.45.1') })
    expect(unresolved.checks.find((c) => c.id === 'npx')?.ok).toBe(false)
  })

  it('runs the binaries it resolved, by absolute path', async () => {
    const seen: string[] = []
    await runPreflight({ ...base, run: async (c) => { seen.push(c); return { ok: true, stdout: 'v22.23.5 1.2.3 2.45.1' } } })
    expect(seen).toEqual(['/opt/node/bin/node', '/opt/node/bin/npx', '/usr/bin/git'])
  })

  it('fails on Windows and when signed out', async () => {
    expect((await runPreflight({ ...base, platform: 'win32', run: run('v22.23.5', 'git version 2.45.1') })).failure?.kind).toBe('unsupported_os')
    expect((await runPreflight({ ...base, isSignedIn: async () => false, run: run('v22.23.5', 'git version 2.45.1') })).failure?.kind).toBe('not_signed_in')
  })

  it('fails when the server has no published version', async () => {
    const result = await runPreflight({ ...base, api: { ...ok, getHarnessVersion: async () => ({ version: null, nodeEngines: null }) }, run: run('v22.23.5', 'git version 2.45.1') })
    expect(result.failure?.kind).toBe('version_unavailable')
  })
})

describe('computer service instance', () => {
  it('hashes the exact --control-plane origin 20x passes, with tenant and user ids', async () => {
    const { createHash } = await import('node:crypto')
    const client = new EnterpriseRunnersApi({
      apiRequest: async () => ({}),
      getApiUrl: () => 'https://api.peakflo.ai',
      isSignedIn: async () => true,
      getIdentity: async () => ({ tenantId: 'T', userId: 'U' })
    })
    const expected = 'computer-' + createHash('sha256').update('https://api.peakflo.ai:T:U').digest('hex').slice(0, 24)
    expect(await client.getComputerInstance()).toBe(expected)
  })
})
