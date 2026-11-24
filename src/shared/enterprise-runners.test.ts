import { describe, expect, it } from 'vitest'
import {
  buildConnectCommand,
  buildUninstallCommand,
  buildRunnerUninstallCommand,
  buildUninstallPlan,
  serviceLogPath,
  compareHarnessVersions,
  deriveVersionState,
  machinesNeedingUpdate,
  normaliseMachines,
  previewConnectCommand,
  redactSecrets,
  satisfiesNodeRange,
  type MachineUpdateInfo,
  type RawByoMachine,
  type RawRunner
} from './enterprise-runners'

const ID = '3f6c2a9e-8b1d-4c7a-9e2f-5d4b1a0c7e63'
const base = { version: '1.8.2', connectionId: ID, controlPlane: 'https://api.peakflo.ai' }

describe('buildConnectCommand', () => {
  it('pins the server version and passes only the connection uuid', () => {
    const cmd = buildConnectCommand({ ...base })
    expect(cmd.command).toBe('npx')
    expect(cmd.args).toEqual([
      '--yes',
      '@peakflo/agent-harness@1.8.2',
      'connect',
      '--connection',
      ID,
      '--control-plane',
      'https://api.peakflo.ai'
    ])
    expect(cmd.display).toBe(`npx --yes @peakflo/agent-harness@1.8.2 connect --connection ${ID} --control-plane https://api.peakflo.ai`)
  })

  it('accepts release candidates but never "latest" or ranges', () => {
    expect(() => buildConnectCommand({ ...base, version: '1.9.0-rc.3' })).not.toThrow()
    for (const version of ['latest', '^1.8.2', '1.8', '', '1.8.2; rm -rf /']) {
      expect(() => buildConnectCommand({ ...base, version })).toThrow()
    }
  })

  it('requires --connection to be a UUID', () => {
    for (const connectionId of ['abc', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig', `${ID}x`, '', 'sk-1234567890123456789012345']) {
      expect(() => buildConnectCommand({ ...base, connectionId })).toThrow(/UUID/)
    }
  })

  it('adds a vendor positionally, and --ask only without a vendor', () => {
    expect(buildConnectCommand({ ...base, vendor: 'codex' }).args.slice(0, 4)).toEqual(['--yes', '@peakflo/agent-harness@1.8.2', 'connect', 'codex'])
    expect(buildConnectCommand({ ...base, ask: true }).args).toContain('--ask')
    expect(() => buildConnectCommand({ ...base, vendor: 'cursor', ask: true })).toThrow(/All detected/)
    expect(() => buildConnectCommand({ ...base, vendor: 'bogus' as never })).toThrow()
  })

  it('never emits --all or --token', () => {
    for (const input of [{}, { vendor: 'codex' as const }, { ask: true }]) {
      const args = buildConnectCommand({ ...base, ...input }).args
      expect(args).not.toContain('--all')
      expect(args.join(' ')).not.toMatch(/--token/)
    }
  })

  it('uses the control-plane URL of each environment', () => {
    const plane = (controlPlane: string) => buildConnectCommand({ ...base, controlPlane }).args.at(-1)
    expect(plane('https://api.peakflo.ai')).toBe('https://api.peakflo.ai')
    expect(plane('https://stage-api.peakflo.ai/')).toBe('https://stage-api.peakflo.ai')
    expect(plane('http://localhost:2000')).toBe('http://localhost:2000')
  })

  it('rejects an insecure or credential-carrying control plane', () => {
    for (const controlPlane of ['http://api.peakflo.ai', 'https://u:p@api.peakflo.ai', 'https://api.peakflo.ai/?token=x', 'nope']) {
      expect(() => buildConnectCommand({ ...base, controlPlane })).toThrow()
    }
  })

  it('previews with a placeholder, never a real id', () => {
    const preview = previewConnectCommand({ version: '1.8.2', controlPlane: 'https://api.peakflo.ai', ask: true })
    expect(preview).toContain('--connection <connection-id>')
    expect(preview).toContain('--ask')
  })
})

describe('uninstall commands', () => {
  const INSTANCE = 'computer-0123456789abcdef01234567'

  it('always targets the per-instance service that connect installed', () => {
    expect(buildUninstallCommand('1.8.2', 'codex')).toBe('npx --yes @peakflo/agent-harness@1.8.2 service uninstall --vendor codex')
    expect(buildUninstallCommand('1.8.2', INSTANCE)).toBe(`npx --yes @peakflo/agent-harness@1.8.2 service uninstall --vendor ${INSTANCE}`)
    expect(buildUninstallCommand(null, 'cursor')).toBe('npx --yes @peakflo/agent-harness service uninstall --vendor cursor')
  })

  it('refuses anything that is not a known instance name', () => {
    for (const bad of ['', 'base', 'computer-xyz', 'codex; rm -rf /', 'computer-0123456789ABCDEF01234567']) {
      expect(() => buildUninstallCommand('1.8.2', bad)).toThrow()
    }
  })

  const RUNNER = '5b1f3c2a-9d4e-4f6a-8c7b-0a1b2c3d4e5f'
  const plan = (patch: Partial<Parameters<typeof buildUninstallPlan>[0]> = {}) =>
    buildUninstallPlan({ version: '1.8.2', runnerId: RUNNER, instances: [], ...patch })

  it('plans one --vendor command per recorded instance, deduplicated', () => {
    const p = plan({ instances: ['codex', 'codex', 'claude-code', 'junk'] })
    expect(p.commands.map((c) => c.split('--vendor ')[1])).toEqual(['codex', 'claude-code'])
    expect(p.note).toBeNull()
  })

  it('uses the scoped --runner command when the pinned harness supports it', () => {
    const p = plan({ version: '1.9.0', instances: ['codex'], minRunnerScopedVersion: '1.9.0' })
    expect(p).toEqual({ commands: [`npx --yes @peakflo/agent-harness@1.9.0 service uninstall --runner ${RUNNER}`], note: null })
    expect(plan({ version: '1.10.0', minRunnerScopedVersion: '1.9.0' }).commands[0]).toContain('--runner')
    expect(plan({ version: '1.9.0-rc.1', minRunnerScopedVersion: '1.9.0' }).commands).toEqual([])
  })

  it('falls back to --vendor when the pinned harness is older or the minimum is not known yet', () => {
    expect(plan({ version: '1.8.2', instances: ['cursor'], minRunnerScopedVersion: '1.9.0' }).commands[0]).toContain('--vendor cursor')
    expect(plan({ version: '1.9.0', instances: ['cursor'], minRunnerScopedVersion: null }).commands[0]).toContain('--vendor cursor')
    expect(plan({ version: null, instances: ['cursor'], minRunnerScopedVersion: '1.9.0' }).commands[0]).toContain('--vendor cursor')
  })

  it('never shows --all, and the scoped form needs a uuid', () => {
    for (const p of [plan({ instances: ['codex'] }), plan({ version: '1.9.0', minRunnerScopedVersion: '1.9.0' }), plan()]) {
      expect(JSON.stringify(p)).not.toMatch(/--all/)
    }
    expect(() => buildRunnerUninstallCommand('1.9.0', 'not-a-uuid')).toThrow()
  })

  it('for a machine connected elsewhere, shows service status guidance instead of a guessed name', () => {
    const p = plan()
    expect(p.commands).toEqual([])
    expect(p.note).toMatch(/not connected from this 20x/)
    expect(p.note).toMatch(/service status/)
    expect(p.note).toMatch(/--vendor <name>/)
  })

  it('logs per instance', () => {
    expect(serviceLogPath(INSTANCE)).toBe(`~/.pf-agent-harness/logs/${INSTANCE}`)
    expect(serviceLogPath(null)).toBe('~/.pf-agent-harness/logs')
  })

  it('knows instances only for machines this 20x connected, matched by host name', () => {
    const records = [
      { instance: INSTANCE, machineName: 'studio-mac', controlPlane: 'https://api.peakflo.ai', connectedAt: 1 },
      { instance: 'codex', machineName: 'build-box-01', controlPlane: 'https://api.peakflo.ai', connectedAt: 2 }
    ]
    const rows = normaliseMachines({
      machines: [
        { runnerId: 'a', name: 'studio-mac.local', personal: true, isOwner: true, registered: true, discovery: true },
        { runnerId: 'b', name: 'elsewhere', personal: true, isOwner: true, registered: true, discovery: true },
        { runnerId: 'c', name: 'build-box-01', personal: true, isOwner: true, registered: true, vendors: ['codex'] }
      ],
      runners: null,
      pinnedVersion: null,
      connectionRecords: records
    })
    expect(rows.find((r) => r.id === 'a')?.serviceInstances).toEqual([INSTANCE])
    expect(rows.find((r) => r.id === 'b')?.serviceInstances).toEqual([]) // never guessed
    expect(rows.find((r) => r.id === 'c')?.serviceInstances).toEqual(['codex'])
  })

  it('a server-reported instance still wins', () => {
    const [row] = normaliseMachines({ machines: [{ runnerId: 'r', name: 'n', personal: true, isOwner: true, registered: true, serviceInstance: 'computer-aaaaaaaaaaaaaaaaaaaaaaaa' }], runners: null, pinnedVersion: null, connectionRecords: [] })
    expect(row.serviceInstances).toEqual(['computer-aaaaaaaaaaaaaaaaaaaaaaaa'])
  })
})

describe('redactSecrets', () => {
  it('removes token-like values and one-time URL parameters', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'
    const url = 'https://app.peakflo.ai/connect-computer?connection=' + ID + '&state=abcDEF123&challenge=Zm9vYmFy&port=8123'
    const text = [
      `Authorization: Bearer ${jwt}`,
      `token ${jwt}`,
      'key sk-abcdefghijklmnopqrstuvwxyz012345',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'PF_ENROLMENT_TOKEN=abc123secret',
      'verifier ' + 'A'.repeat(50),
      url
    ].join('\n')
    const out = redactSecrets(text)
    expect(out).not.toContain(jwt)
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
    expect(out).not.toContain('ghp_abcdef')
    expect(out).not.toContain('abc123secret')
    expect(out).not.toContain('A'.repeat(50))
    expect(out).not.toContain('abcDEF123')
    expect(out).not.toContain('Zm9vYmFy')
    expect(out).toContain(ID)
  })

  it('keeps ordinary progress text', () => {
    const line = '✓ Approved for Northwind Demo Co.'
    expect(redactSecrets(line)).toBe(line)
    expect(redactSecrets('installing launchd service ai.peakflo.agent-harness')).toContain('ai.peakflo.agent-harness')
  })
})

describe('versions', () => {
  it('compares published versions', () => {
    expect(compareHarnessVersions('1.7.0', '1.8.2')).toBeLessThan(0)
    expect(compareHarnessVersions('1.8.2', '1.8.2')).toBe(0)
    expect(compareHarnessVersions('1.9.0-rc.1', '1.9.0')).toBeLessThan(0)
    expect(compareHarnessVersions('1.9.0-rc.1', '1.9.0-rc.2')).toBeLessThan(0)
    expect(compareHarnessVersions('weird', '1.0.0')).toBeNull()
  })

  it('checks the harness engines range', () => {
    const range = '^22.23.5 || ^24.22.3 || >=26.13.1 <27'
    expect(satisfiesNodeRange('22.23.5', range)).toBe(true)
    expect(satisfiesNodeRange('22.30.0', range)).toBe(true)
    expect(satisfiesNodeRange('22.4.0', range)).toBe(false)
    expect(satisfiesNodeRange('23.0.0', range)).toBe(false)
    expect(satisfiesNodeRange('24.22.3', range)).toBe(true)
    expect(satisfiesNodeRange('26.13.0', range)).toBe(false)
    expect(satisfiesNodeRange('26.13.1', range)).toBe(true)
    expect(satisfiesNodeRange('27.0.0', range)).toBe(false)
    expect(satisfiesNodeRange('20.0.0', null)).toBe(true)
    expect(satisfiesNodeRange('garbage', range)).toBe(false)
  })

  it('does not fail open on "operator space version"', () => {
    expect(satisfiesNodeRange('22.0.0', '>= 24')).toBe(false)
    expect(satisfiesNodeRange('24.1.0', '>= 24')).toBe(true)
    expect(satisfiesNodeRange('23.9.0', '>=  24.0.0 < 26')).toBe(false)
    expect(satisfiesNodeRange('25.0.0', '>= 24.0.0 < 26')).toBe(true)
    expect(satisfiesNodeRange('26.0.0', '>= 24.0.0 < 26')).toBe(false)
    expect(satisfiesNodeRange('21.0.0', '^ 22.1.0')).toBe(false)
  })

  it('treats a partial version as the whole line', () => {
    for (const range of ['22', '22.x', '22.*', '~22', '^22', '=22']) {
      expect(satisfiesNodeRange('22.0.0', range)).toBe(true)
      expect(satisfiesNodeRange('22.99.3', range)).toBe(true)
      expect(satisfiesNodeRange('21.9.9', range)).toBe(false)
      expect(satisfiesNodeRange('23.0.0', range)).toBe(false)
    }
    expect(satisfiesNodeRange('22.4.9', '22.4')).toBe(true)
    expect(satisfiesNodeRange('22.5.0', '22.4')).toBe(false)
    expect(satisfiesNodeRange('22.4.9', '~22.4')).toBe(true)
    expect(satisfiesNodeRange('22.5.0', '~22.4')).toBe(false)
    expect(satisfiesNodeRange('22.9.0', '<=22')).toBe(true)
    expect(satisfiesNodeRange('23.0.0', '<=22')).toBe(false)
    expect(satisfiesNodeRange('22.9.0', '>22')).toBe(false)
    expect(satisfiesNodeRange('23.0.0', '>22')).toBe(true)
    expect(satisfiesNodeRange('5.0.0', '*')).toBe(true)
  })
})

const update = (patch: Partial<MachineUpdateInfo> = {}): MachineUpdateInfo => ({
  supported: true,
  selfUpdate: true,
  available: false,
  targetVersion: null,
  state: null,
  reason: null,
  nowRequested: false,
  ...patch
})

describe('deriveVersionState', () => {
  it('is up to date when the server has no newer target', () => {
    expect(deriveVersionState({ version: '1.8.2', update: update({ targetVersion: '1.8.2' }), refused: false, pinnedVersion: '1.8.2' }).kind).toBe('up_to_date')
  })

  it('warns only when an update is available', () => {
    const state = deriveVersionState({ version: '1.7.0', update: update({ available: true, targetVersion: '1.8.2' }), refused: false, pinnedVersion: '1.8.2' })
    expect(state).toMatchObject({ kind: 'update_available', target: '1.8.2' })
  })

  it('is refused on a 426 / protocol-too-old runner, and that wins over "update available"', () => {
    expect(deriveVersionState({ version: '1.5.1', update: update({ available: true, targetVersion: '1.8.2' }), refused: true, pinnedVersion: '1.8.2' }).kind).toBe('refused')
    expect(deriveVersionState({ version: '1.5.1', update: update({ state: 'refused', reason: 'protocol too old' }), refused: false, pinnedVersion: '1.8.2' })).toMatchObject({ kind: 'refused', reason: 'protocol too old' })
  })

  it('falls back to the server pin when no update decision was returned', () => {
    expect(deriveVersionState({ version: '1.7.0', update: null, refused: false, pinnedVersion: '1.8.2' }).kind).toBe('update_available')
    expect(deriveVersionState({ version: '1.8.2', update: null, refused: false, pinnedVersion: '1.8.2' }).kind).toBe('up_to_date')
    expect(deriveVersionState({ version: null, update: null, refused: false, pinnedVersion: '1.8.2' }).kind).toBe('unknown')
  })

  it('reports an update in progress', () => {
    expect(deriveVersionState({ version: '1.7.0', update: update({ available: true, state: 'updating', targetVersion: '1.8.2' }), refused: false, pinnedVersion: '1.8.2' }).updating).toBe(true)
  })
})

describe('normaliseMachines', () => {
  const now = Date.parse('2026-11-23T12:00:00Z')
  const machines: RawByoMachine[] = [
    { runnerId: 'm1', name: 'studio-mac', personal: true, isOwner: true, canManage: true, harnessVersion: '1.8.2', update: { supported: true, selfUpdate: true, available: false, targetVersion: '1.8.2' }, agents: [{ agentId: 'a1', name: 'Reviewer', backend: 'claude-code' }], registered: true },
    { runnerId: 'm2', name: 'build-box-01', personal: true, isOwner: true, canManage: true, harnessVersion: '1.7.0', update: { supported: true, selfUpdate: true, available: true, targetVersion: '1.8.2' }, registered: true },
    { runnerId: 'm3', name: 'old-laptop', personal: true, isOwner: true, canManage: true, harnessVersion: '1.5.1', update: { supported: true, selfUpdate: true, available: false, state: 'refused', reason: 'Protocol too old' }, registered: true }
  ]
  const runners: RawRunner[] = [
    { id: 'm1', name: 'studio-mac', personal: true, canSelect: true, status: 'ready', lastHeartbeatAt: '2026-11-23T11:59:30Z', capabilities: { os: 'darwin', arch: 'arm64', hostname: 'studio-mac.local', backends: [{ name: 'claude-code' }, { name: 'codex' }] }, selectable: true, activeSessionCount: 0 },
    { id: 'm2', name: 'build-box-01', personal: true, canSelect: true, status: 'ready', lastHeartbeatAt: '2026-11-23T11:59:50Z', capabilities: { os: 'linux', arch: 'x64', backends: [{ name: 'claude-code' }, { name: 'pi' }] }, selectable: true, activeSessionCount: 2 },
    { id: 'm3', name: 'old-laptop', personal: true, canSelect: true, status: 'offline', lastHeartbeatAt: '2026-11-23T09:00:00Z', capabilities: { os: 'darwin', arch: 'x64', backends: [{ name: 'claude-code' }] }, selectable: false, unselectableReason: 'protocol_unsupported' },
    { id: 's1', name: 'Peakflo shared', personal: false, canSelect: false, status: 'ready', lastHeartbeatAt: '2026-11-23T11:59:55Z', capabilities: { os: 'linux', arch: 'x64', backends: [{ name: 'pi' }, { name: 'claude-code' }] }, selectable: true },
    { id: 'x1', name: "teammate's mac", personal: true, canSelect: false, status: 'ready', lastHeartbeatAt: '2026-11-23T11:59:55Z' }
  ]

  const rows = normaliseMachines({ machines, runners, pinnedVersion: '1.8.2', hostname: 'studio-mac', now })
  const row = (id: string) => rows.find((r) => r.id === id)!

  it('splits my machines and shared runners, and hides other people’s personal machines', () => {
    expect(rows.map((r) => r.id)).toEqual(['m2', 'm1', 'm3', 's1'])
    expect(row('s1').scope).toBe('shared')
    expect(row('s1').canManage).toBe(false)
  })

  it('derives status, harnesses, platform, pins and this computer', () => {
    expect(row('m1')).toMatchObject({ status: 'online', platform: 'macOS · arm64', thisComputer: true, harnesses: ['claude-code', 'codex'] })
    expect(row('m1').pinnedAgents).toEqual([{ id: 'a1', name: 'Reviewer', backend: 'claude-code' }])
    expect(row('m2')).toMatchObject({ status: 'busy', activeSessions: 2 })
    expect(row('m3').status).toBe('refused')
  })

  it('marks update available vs refused', () => {
    expect(row('m1').versionState.kind).toBe('up_to_date')
    expect(row('m2').versionState.kind).toBe('update_available')
    expect(row('m3').versionState.kind).toBe('refused')
  })

  it('treats a stale heartbeat as offline even if the server still says ready', () => {
    const stale = normaliseMachines({ machines: null, runners: [{ id: 'z', name: 'z', personal: false, status: 'ready', lastHeartbeatAt: '2026-11-23T10:00:00Z' }], pinnedVersion: null, now })
    expect(stale[0].status).toBe('offline')
  })

  it('offers "Update all" only for machines I can manage that are behind or refused', () => {
    expect(machinesNeedingUpdate(rows).map((r) => r.id)).toEqual(['m2', 'm3'])
  })
})
