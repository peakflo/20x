import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import type { ConnectProgress } from '../../shared/enterprise-runners'
import { redactSecrets } from '../../shared/enterprise-runners'
import { buildCleanEnv, findSecretLookingKeys } from './clean-env'
import { ConnectRunner } from './connect-runner'
import { ConnectOutputParser } from './output-parser'

const ID = '3f6c2a9e-8b1d-4c7a-9e2f-5d4b1a0c7e63'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'

class FakeChild extends EventEmitter {
  pid: number | undefined = undefined
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  kill = vi.fn((signal?: string) => {
    this.killed = true
    // A killed process closes with a signal exit.
    queueMicrotask(() => this.emit('close', null, signal))
    return true
  })
  out(text: string) { this.stdout.write(text) }
  err(text: string) { this.stderr.write(text) }
  end(code: number) { this.emit('close', code) }
}

const SECRET_PARENT_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/test',
  LANG: 'en_US.UTF-8',
  ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
  OPENAI_API_KEY: 'sk-proj-abcdefghijklmnopqrstuvwxyz',
  GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  ENTERPRISE_JWT: JWT,
  PF_ENROLMENT_TOKEN: 'enrol-secret-value',
  CODEX_HOME: '/Users/test/.codex',
  CLAUDE_CONFIG_DIR: '/Users/test/.claude',
  NPM_CONFIG_REGISTRY: 'https://registry.corp.example/',
  SECRET_BROKER_URL: 'http://127.0.0.1:9999',
  HTTPS_PROXY: 'http://user:hunter2@proxy.corp:3128',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  NPM_TOKEN: 'npm_abcdefghijklmnopqrstuvwxyz'
}

function setup(options: { platform?: NodeJS.Platform; version?: string | null; pid?: number; graceMs?: number; npx?: string | null; parentEnv?: NodeJS.ProcessEnv; createConnection?: () => Promise<{ connectionId: string; expiresAt: string | null }> } = {}) {
  const child = new FakeChild()
  child.pid = options.pid
  const killGroup = vi.fn()
  const records: Array<{ instance: string; machineName: string | null; controlPlane: string; connectedAt: number }> = []
  const spawn = vi.fn(() => child as unknown as ChildProcess)
  const progress: ConnectProgress[] = []
  const openExternal = vi.fn()
  const onConnected = vi.fn()
  const logs: string[] = []
  const api = {
    getApiUrl: () => 'https://api.peakflo.ai',
    getHarnessVersion: vi.fn(async () => ({ version: options.version === undefined ? '1.8.2' : options.version, nodeEngines: null })),
    createConnection: vi.fn(options.createConnection ?? (async () => ({ connectionId: ID, expiresAt: null })))
  }
  const runner = new ConnectRunner({
    api,
    spawn: spawn as never,
    platform: options.platform ?? 'darwin',
    parentEnv: options.parentEnv ?? SECRET_PARENT_ENV,
    resolveToolchain: () => ({ node: '/opt/node/bin/node', npx: options.npx === undefined ? '/opt/node/bin/npx' : options.npx }),
    cwd: '/Users/test',
    killGroup,
    graceMs: options.graceMs ?? 5000,
    computerInstance: async () => 'computer-0123456789abcdef01234567',
    recordConnection: (r) => records.push(r),
    openExternal,
    onProgress: (p) => progress.push(p),
    onConnected,
    newId: () => 'run-1',
    log: (m) => logs.push(m)
  })
  const last = () => progress[progress.length - 1]
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
  return { child, spawn, killGroup, records, runner, api, progress, last, tick, openExternal, onConnected, logs }
}

describe('ConnectRunner — spawn arguments', () => {
  it('runs the pinned harness with only a UUID in argv', async () => {
    const t = setup()
    const result = await t.runner.start({ vendor: 'all', ask: true })
    expect(result).toEqual({ ok: true, runId: 'run-1' })
    const [command, args, options] = t.spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv; shell: boolean; stdio: unknown }]
    expect(command).toBe('/opt/node/bin/npx')
    expect(args).toEqual(['--yes', '@peakflo/agent-harness@1.8.2', 'connect', '--ask', '--connection', ID, '--control-plane', 'https://api.peakflo.ai'])
    expect(options.shell).toBe(false)
    expect(options).toMatchObject({ detached: true, cwd: '/Users/test' })
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe'])
    const argv = args.join(' ')
    expect(argv).not.toMatch(/--token|--all/)
    expect(argv).not.toContain(JWT)
    expect(redactSecrets(argv)).toBe(argv) // nothing token-like in argv
  })

  it('creates the connection with the vendors it is allowed to connect, and asks the server for the pin', async () => {
    const all = setup()
    await all.runner.start({ vendor: 'all', ask: false })
    expect(all.api.createConnection).toHaveBeenCalledWith(['claude-code', 'codex', 'cursor'], undefined)

    const one = setup()
    await one.runner.start({ vendor: 'codex', ask: false })
    expect(one.api.createConnection).toHaveBeenCalledWith(['codex'], undefined)
    expect((one.spawn.mock.calls[0] as unknown as [string, string[]])[1]).toContain('codex')

    // --ask with a single vendor is refused (the UI disables it; this is the backstop).
    const asked = setup()
    expect(await asked.runner.start({ vendor: 'codex', ask: true })).toMatchObject({ ok: false })
    expect(asked.spawn).not.toHaveBeenCalled()
  })

  it('passes the replaced machine on Reconnect, and refuses a non-uuid id', async () => {
    const t = setup()
    await t.runner.start({ vendor: 'all', ask: false, replacesRunnerId: ID })
    expect(t.api.createConnection).toHaveBeenCalledWith(expect.anything(), ID)
    const bad = setup()
    const result = await bad.runner.start({ vendor: 'all', ask: false, replacesRunnerId: 'not-a-uuid' })
    expect(result.ok).toBe(false)
    expect(bad.spawn).not.toHaveBeenCalled()
  })

  it('gives the child a clean environment: no 20x secrets, nothing secret-looking', async () => {
    const t = setup()
    await t.runner.start({ vendor: 'all', ask: false })
    const env = (t.spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env
    expect(env.PATH).toBe('/opt/node/bin:/usr/bin:/bin')
    expect(env.HOME).toBe('/Users/test')
    for (const key of Object.keys(SECRET_PARENT_ENV)) {
      if (!['PATH', 'HOME', 'LANG', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'NPM_CONFIG_REGISTRY'].includes(key)) expect(env).not.toHaveProperty(key)
    }
    expect(findSecretLookingKeys(env)).toEqual([])
    const values = Object.values(env).join('\n')
    expect(values).not.toMatch(/sk-ant|sk-proj|ghp_|eyJ|enrol-secret|hunter2|aws-secret|npm_abc/)
  })

  it('never takes a token from the server response', async () => {
    const t = setup({ createConnection: async () => ({ connectionId: ID, expiresAt: null, enrolmentToken: 'enrol-secret-value' } as never) })
    await t.runner.start({ vendor: 'all', ask: false })
    const call = JSON.stringify(t.spawn.mock.calls[0])
    expect(call).not.toContain('enrol-secret-value')
  })

  it('does not start without a published version, on Windows, or twice', async () => {
    const none = setup({ version: null })
    expect(await none.runner.start({ vendor: 'all', ask: false })).toMatchObject({ ok: false, failure: { kind: 'version_unavailable' } })
    expect(none.spawn).not.toHaveBeenCalled()

    const win = setup({ platform: 'win32' })
    expect(await win.runner.start({ vendor: 'all', ask: false })).toMatchObject({ ok: false, failure: { kind: 'unsupported_os' } })
    expect(win.api.createConnection).not.toHaveBeenCalled()

    const twice = setup()
    await twice.runner.start({ vendor: 'all', ask: false })
    expect(await twice.runner.start({ vendor: 'all', ask: false })).toMatchObject({ ok: false })
  })

  it('maps API failures: signed out, permission denied, rate limited', async () => {
    const make = (error: Error) => setup({ createConnection: async () => { throw error } })
    const denied = make(Object.assign(new Error('Connecting a machine needs the coding-agents:create permission.'), { status: 403 }))
    expect(await denied.runner.start({ vendor: 'all', ask: false })).toMatchObject({ ok: false, failure: { kind: 'permission_denied' } })
    const signedOut = make(Object.assign(new Error('Session expired — please sign in again'), { status: 401 }))
    expect(await signedOut.runner.start({ vendor: 'all', ask: false })).toMatchObject({ ok: false, failure: { kind: 'not_signed_in' } })
    const limited = make(Object.assign(new Error('Too many connection attempts. Try again later.'), { status: 429 }))
    expect(await limited.runner.start({ vendor: 'all', ask: false })).toMatchObject({ ok: false, failure: { kind: 'rate_limited' } })
  })
})

describe('ConnectRunner — output → steps', () => {
  it('walks Connection → Approve → Register → Service → success', async () => {
    const t = setup()
    await t.runner.start({ vendor: 'all', ask: false })
    t.child.out('Connecting this computer on studio-mac…\n')
    await t.tick()
    expect(t.last().steps.connection).toBe('done')
    expect(t.last().machineName).toBe('studio-mac')

    t.child.out(`\nApprove this computer in your browser:\n    https://app.peakflo.ai/connect-computer?connection=${ID}&vendor=computer&machine=studio-mac&port=7123&state=SECRETSTATE123&challenge=SECRETCHALLENGE456\nWaiting for approval… (Ctrl-C to cancel)\n`)
    await t.tick()
    expect(t.last().steps.approve).toBe('active')
    // One-time parameters never reach the renderer's progress.
    expect(t.last().approveUrl).toContain(`connection=${ID}`)
    expect(JSON.stringify(t.last())).not.toMatch(/SECRETSTATE123|SECRETCHALLENGE456/)

    t.child.out('✓ Approved for Northwind Demo Co.\n')
    await t.tick()
    expect(t.last()).toMatchObject({ company: 'Northwind Demo Co', steps: { approve: 'done', register: 'active' } })

    t.child.out('✓ This computer is registered as your personal runner.\nSetting up the background service…\n')
    await t.tick()
    expect(t.last().steps).toMatchObject({ register: 'done', service: 'active' })

    t.child.out('✓ Background service installed. It starts when you log in.\n✓ Added Claude Code.\n✓ Added Codex.\n\n✓ This computer is connected to Northwind Demo Co on studio-mac. Return to Spaces.\n')
    t.child.out('✓ Computer is connected to Northwind Demo Co on studio-mac. Return to Spaces.\n')
    await t.tick()
    t.child.end(0)
    await t.tick()
    expect(t.last().phase).toBe('success')
    expect(t.last().steps).toEqual({ connection: 'done', approve: 'done', register: 'done', service: 'done' })
    expect(t.last().harnessesConnected).toEqual(['Claude Code', 'Codex'])
    expect(t.onConnected).toHaveBeenCalledTimes(1)
  })

  it('reassembles lines split across chunks', () => {
    const parser = new ConnectOutputParser()
    const a = parser.feed('stdout', '✓ Appr')
    const b = parser.feed('stdout', 'oved for Acme.\n')
    expect(a).toEqual([])
    expect(b.some((e) => e.type === 'company' && e.name === 'Acme')).toBe(true)
  })

  it('strips terminal control sequences', () => {
    const parser = new ConnectOutputParser()
    const events = parser.feed('stdout', '\u001b[32m✓ Approved for Acme.\u001b[0m\n')
    expect(events.find((e) => e.type === 'company')).toMatchObject({ name: 'Acme' })
  })
})

describe('redaction of output', () => {
  it('redacts token-like text before it is shown, kept or logged', async () => {
    const t = setup()
    await t.runner.start({ vendor: 'all', ask: false })
    t.child.out(`debug Authorization: Bearer ${JWT}\n`)
    t.child.out(`debug PF_ENROLMENT_TOKEN=enrol-secret-value\n`)
    t.child.err(`ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked?\n`)
    await t.tick()
    const shown = JSON.stringify(t.last())
    const logged = t.logs.join('\n')
    for (const text of [shown, logged]) {
      expect(text).not.toContain(JWT)
      expect(text).not.toContain('enrol-secret-value')
      expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz')
    }
    expect(t.last().lines.length).toBe(3)
  })
})

describe('failure states', () => {
  async function failWith(stream: 'out' | 'err', text: string, code = 1, setupOptions: Parameters<typeof setup>[0] = {}, before = '') {
    const t = setup(setupOptions)
    await t.runner.start({ vendor: 'all', ask: false })
    if (before) t.child.out(before)
    t.child[stream](text)
    await t.tick()
    t.child.end(code)
    await t.tick()
    return t.last()
  }

  it('approval denied or cancelled', async () => {
    const p = await failWith('err', '\n✗ Approval denied in the browser.\n', 1, {}, 'Approve this computer in your browser:\n    https://app.peakflo.ai/connect-computer?connection=' + ID + '\n')
    expect(p.phase).toBe('failed')
    expect(p.failure?.kind).toBe('denied')
    expect(p.steps.approve).toBe('failed')
  })

  it('cancelling kills the process and says nothing was installed', async () => {
    const t = setup()
    await t.runner.start({ vendor: 'all', ask: false })
    t.runner.cancel('run-1')
    await t.tick()
    expect(t.child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(t.last().phase).toBe('cancelled')
    expect(t.last().failure?.message).toMatch(/Nothing was installed/)
  })

  it('link expired', async () => {
    const p = await failWith('err', '\n✗ Timed out waiting for approval in the browser. Run the command again.\n')
    expect(p.failure?.kind).toBe('expired')
    const q = await failWith('err', '\n✗ This approval could not be used (404). Open Agents → "Reconnect" to get a new command.\n')
    expect(q.failure?.kind).toBe('expired')
  })

  it('Node missing / too old', async () => {
    const spawnMissing = setup()
    await spawnMissing.runner.start({ vendor: 'all', ask: false })
    spawnMissing.child.emit('error', Object.assign(new Error('spawn npx ENOENT'), { code: 'ENOENT' }))
    await spawnMissing.tick()
    expect(spawnMissing.last().failure).toMatchObject({ kind: 'node_missing', help: 'brew install node' })

    const old = await failWith('err', 'Node.js 20.1.0 is too old: this harness requires ^22.23.5\n')
    expect(old.failure?.kind).toBe('node_missing')
  })

  it('Git missing', async () => {
    const p = await failWith('err', '✗ spawn git ENOENT: git not found\n')
    expect(p.failure?.kind).toBe('git_missing')
  })

  it('service failed, with the log path', async () => {
    const p = await failWith(
      'err',
      '\n✗ The runner is registered, but its service has not started. Run this same command again to repair it.\n',
      1,
      {},
      'Setting up the background service…\n'
    )
    expect(p.failure).toMatchObject({ kind: 'service_failed', logPath: '~/.pf-agent-harness/logs/computer-0123456789abcdef01234567' })
    expect(p.steps.service).toBe('failed')
  })

  it('harness not installed / signed in', async () => {
    const p = await failWith('err', '\n✗ Codex is not installed on this computer.\n  Install it:  npm install -g @openai/codex\n')
    expect(p.failure?.kind).toBe('vendor_missing')
  })

  it('Windows', async () => {
    const t = setup({ platform: 'win32' })
    expect(await t.runner.start({ vendor: 'all', ask: false })).toMatchObject({ ok: false, failure: { kind: 'unsupported_os' } })
  })

  it('an unexpected exit is reported, not hidden', async () => {
    const p = await failWith('out', 'something odd\n', 7)
    expect(p.phase).toBe('failed')
    expect(p.failure?.kind).toBe('unknown')
  })

  it('a clean exit without the success line is not success', async () => {
    const p = await failWith('out', 'Connecting this computer on studio-mac…\n', 0)
    expect(p.phase).toBe('failed')
  })
})

describe('approval page', () => {
  it('re-opens only a Peakflo approval page', async () => {
    const t = setup()
    await t.runner.start({ vendor: 'all', ask: false })
    t.child.out(`    https://app.peakflo.ai/connect-computer?connection=${ID}&state=S&challenge=C&port=7000\n`)
    await t.tick()
    expect(await t.runner.openApprovalPage('run-1')).toBe(true)
    expect(t.openExternal).toHaveBeenCalledWith(expect.stringContaining('https://app.peakflo.ai/connect-computer?'))

    const evil = setup()
    await evil.runner.start({ vendor: 'all', ask: false })
    evil.child.out(`    https://evil.example.com/connect-computer?connection=${ID}\n`)
    await evil.tick()
    expect(await evil.runner.openApprovalPage('run-1')).toBe(false)
    expect(evil.openExternal).not.toHaveBeenCalled()
  })
})

describe('buildCleanEnv', () => {
  it('is an allowlist', () => {
    const env = buildCleanEnv({ ...SECRET_PARENT_ENV, SOMETHING_NEW: 'x' })
    expect(Object.keys(env).sort()).toEqual(
      ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HOME', 'LANG', 'NPM_CONFIG_REGISTRY', 'PATH', 'npm_config_audit', 'npm_config_fund', 'npm_config_update_notifier'].sort()
    )
  })

  it('passes npm registry and vendor config homes, but drops a registry URL with credentials', () => {
    const env = buildCleanEnv({ PATH: '/bin', NPM_CONFIG_REGISTRY: 'https://registry.corp.example/', CODEX_HOME: '/h/.codex', CLAUDE_CONFIG_DIR: '/h/.claude' })
    expect(env).toMatchObject({ NPM_CONFIG_REGISTRY: 'https://registry.corp.example/', CODEX_HOME: '/h/.codex', CLAUDE_CONFIG_DIR: '/h/.claude' })
    expect(buildCleanEnv({ PATH: '/bin', NPM_CONFIG_REGISTRY: 'https://u:tok@registry.corp.example/' }).NPM_CONFIG_REGISTRY).toBeUndefined()
  })

  it('drops relative and empty PATH entries', () => {
    expect(buildCleanEnv({ PATH: ':.:bin:/usr/bin::node_modules/.bin:/bin' }).PATH).toBe('/usr/bin:/bin')
    expect(buildCleanEnv({ PATH: '.:bin' }).PATH).toBeUndefined()
  })

  it('keeps a credential-free proxy but drops one with a password', () => {
    expect(buildCleanEnv({ PATH: '/bin', HTTPS_PROXY: 'http://proxy.corp:3128' }).HTTPS_PROXY).toBe('http://proxy.corp:3128')
    expect(buildCleanEnv({ PATH: '/bin', HTTPS_PROXY: 'http://u:p@proxy.corp:3128' }).HTTPS_PROXY).toBeUndefined()
  })
})

describe('concurrency, cancel and quit', () => {
  it('two simultaneous start() calls spawn once', async () => {
    const t = setup()
    const [a, b] = await Promise.all([t.runner.start({ vendor: 'all', ask: false }), t.runner.start({ vendor: 'all', ask: false })])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    expect(t.spawn).toHaveBeenCalledTimes(1)
    expect(t.api.createConnection).toHaveBeenCalledTimes(1)
  })

  it('a failed start does not block the next one', async () => {
    const t = setup({ version: null })
    expect((await t.runner.start({ vendor: 'all', ask: false })).ok).toBe(false)
    expect((await t.runner.start({ vendor: 'all', ask: false })).ok).toBe(false)
    expect(t.api.getHarnessVersion).toHaveBeenCalledTimes(2)
  })

  it('refuses to start without npx', async () => {
    const t = setup({ npx: null })
    expect(await t.runner.start({ vendor: 'all', ask: false })).toMatchObject({ ok: false, failure: { kind: 'node_missing' } })
    expect(t.spawn).not.toHaveBeenCalled()
  })

  it('kills the whole process group, not just the child', async () => {
    const t = setup({ pid: 4242 })
    await t.runner.start({ vendor: 'all', ask: false })
    t.runner.cancel('run-1')
    expect(t.killGroup).toHaveBeenCalledWith(4242, 'SIGTERM')
    expect(t.child.kill).not.toHaveBeenCalled()
  })

  it('escalates to SIGKILL and still finishes if close never fires', async () => {
    const t = setup({ pid: 4242, graceMs: 10 })
    t.child.kill.mockImplementation(() => true)
    await t.runner.start({ vendor: 'all', ask: false })
    t.runner.cancel('run-1')
    await new Promise((r) => setTimeout(r, 60))
    expect(t.killGroup).toHaveBeenCalledWith(4242, 'SIGKILL')
    expect(t.last().phase).toBe('cancelled')
    // A later start is not blocked forever.
    const again = await t.runner.start({ vendor: 'all', ask: false })
    expect(again.ok).toBe(true)
  })

  it('early cancel: nothing was installed', async () => {
    const t = setup()
    await t.runner.start({ vendor: 'all', ask: false })
    t.child.out('Approve this computer in your browser:\nWaiting for approval… (Ctrl-C to cancel)\n')
    await t.tick()
    expect(t.runner.isPastPointOfNoReturn()).toBe(false)
    t.runner.cancel('run-1')
    await t.tick()
    expect(t.last().failure).toMatchObject({ kind: 'denied' })
    expect(t.last().failure?.message).toMatch(/Nothing was installed/)
  })

  it('cancel after register started says it may be partly installed', async () => {
    const t = setup()
    await t.runner.start({ vendor: 'all', ask: false })
    t.child.out('✓ Approved for Acme.\n')
    await t.tick()
    expect(t.runner.isPastPointOfNoReturn()).toBe(true)
    t.runner.cancel('run-1')
    await t.tick()
    expect(t.last().phase).toBe('cancelled')
    expect(t.last().failure).toMatchObject({ kind: 'cancelled_partial', logPath: '~/.pf-agent-harness/logs/computer-0123456789abcdef01234567' })
    expect(t.last().failure?.message).toMatch(/partly connected/)
    expect(t.last().failure?.message).toMatch(/Reconnect/)
  })

  it('shutdown (app quit) kills the child group', async () => {
    const t = setup({ pid: 99 })
    await t.runner.start({ vendor: 'all', ask: false })
    t.runner.shutdown()
    expect(t.killGroup).toHaveBeenCalledWith(99, 'SIGTERM')
  })
})

describe('failure classification uses error lines, exit code and step state only', () => {
  it('"Waiting for approval… (Ctrl-C to cancel)" is not a cancellation', async () => {
    const t = setup()
    await t.runner.start({ vendor: 'all', ask: false })
    t.child.out('Approve this computer in your browser:\nWaiting for approval… (Ctrl-C to cancel)\n')
    await t.tick()
    t.child.end(1)
    await t.tick()
    expect(t.last().phase).toBe('failed')
    // approve step active, no error text, non-zero exit: the browser step ended without approval
    expect(t.last().failure?.kind).toBe('denied')
    expect(t.last().failure?.message).not.toMatch(/Ctrl-C/)
  })

  it('"Setting up the background service…" alone is not a service failure message', async () => {
    const t = setup()
    await t.runner.start({ vendor: 'all', ask: false })
    t.child.out('✓ This computer is registered as your personal runner.\nConnecting\nSetting up the background service…\n')
    await t.tick()
    t.child.err('✗ Could not reach https://api.peakflo.ai. Check your internet connection and try again.\n')
    await t.tick()
    t.child.end(1)
    await t.tick()
    // The error line wins over the step name; the failure message is the error.
    expect(t.last().failure?.message).toMatch(/Could not reach/)
  })

  it('does not scan ordinary output for failure words', async () => {
    const t = setup()
    await t.runner.start({ vendor: 'all', ask: false })
    t.child.out('Connecting this computer on studio-mac…\nnote: you can cancel or retry; token expired links are refused\n')
    await t.tick()
    t.child.end(3)
    await t.tick()
    expect(t.last().failure?.kind).toBe('unknown')
  })

  it('keeps the install and sign-in help after a ✗ line', async () => {
    const t = setup()
    await t.runner.start({ vendor: 'codex', ask: false })
    t.child.err('\n✗ Codex is not installed on this computer.\n')
    t.child.err('  Install it:  npm install -g @openai/codex\n')
    t.child.err('  Sign in:     codex login\n')
    t.child.err('Then run this command again.\n')
    await t.tick()
    t.child.end(1)
    await t.tick()
    const failure = t.last().failure
    expect(failure?.kind).toBe('vendor_missing')
    expect(failure?.help).toContain('npm install -g @openai/codex')
    expect(failure?.help).toContain('codex login')
    expect(failure?.help).toContain('Then run this command again.')
  })

  it('service failure logs to the per-instance directory', async () => {
    const t = setup()
    await t.runner.start({ vendor: 'cursor', ask: false })
    t.child.out('Setting up the background service…\n')
    t.child.err('✗ The runner is registered, but its service has not started.\n')
    await t.tick()
    t.child.end(1)
    await t.tick()
    expect(t.last().failure).toMatchObject({ kind: 'service_failed', logPath: '~/.pf-agent-harness/logs/cursor' })
  })
})

describe('remembering the connection for the uninstall command', () => {
  it('stores the instance with the machine name only after success', async () => {
    const t = setup()
    await t.runner.start({ vendor: 'all', ask: false })
    t.child.out('Connecting this computer on studio-mac…\n')
    await t.tick()
    expect(t.records).toEqual([])
    t.child.out('✓ Computer is connected to Acme on studio-mac. Return to Spaces.\n')
    await t.tick()
    t.child.end(0)
    await t.tick()
    expect(t.records).toEqual([{ instance: 'computer-0123456789abcdef01234567', machineName: 'studio-mac', controlPlane: 'https://api.peakflo.ai', connectedAt: expect.any(Number) }])
  })

  it('uses the vendor name for a single-vendor connect, and stores nothing on failure', async () => {
    const t = setup()
    await t.runner.start({ vendor: 'codex', ask: false })
    t.child.out('Connecting Codex on box…\n✓ Codex is connected to Acme on box. Return to Spaces.\n')
    await t.tick()
    t.child.end(0)
    await t.tick()
    expect(t.records[0]).toMatchObject({ instance: 'codex', machineName: 'box' })
    const bad = setup()
    await bad.runner.start({ vendor: 'all', ask: false })
    bad.child.err('✗ nope\n')
    await bad.tick()
    bad.child.end(1)
    await bad.tick()
    expect(bad.records).toEqual([])
  })
})
