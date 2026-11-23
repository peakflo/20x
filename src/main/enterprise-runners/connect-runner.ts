import type { ChildProcess, SpawnOptions } from 'node:child_process'
import {
  CONNECT_VENDORS,
  ConnectCommandError,
  buildConnectCommand,
  redactSecrets,
  serviceLogPath,
  type ConnectFailure,
  type ConnectionRecord,
  type ConnectProgress,
  type ConnectStepId,
  type ConnectStepState,
  isUuid,
  type ConnectVendor,
  type StartConnectRequest,
  type StartConnectResult
} from '../../shared/enterprise-runners'
import { toFailure, type EnterpriseRunnersApi } from './api-client'
import { buildCleanEnv } from './clean-env'
import { ConnectOutputParser, classifyFailure, sanitiseApproveUrl, type ConnectEvent } from './output-parser'

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export interface ConnectRunnerDeps {
  api: Pick<EnterpriseRunnersApi, 'getHarnessVersion' | 'createConnection' | 'getApiUrl'>
  spawn: SpawnFn
  platform: NodeJS.Platform
  /** The parent environment to filter. Defaults to `process.env`. */
  parentEnv?: NodeJS.ProcessEnv
  openExternal: (url: string) => Promise<void> | void
  onProgress: (progress: ConnectProgress) => void
  /** Called once when a run reaches `success` so lists can refresh. */
  onConnected?: () => void
  newId?: () => string
  /** Hard stop: the CLI itself waits up to 30 minutes for the browser. */
  timeoutMs?: number
  log?: (message: string) => void
  /** Absolute node/npx on absolute PATH entries. `npx` null → Node/npm missing. */
  resolveToolchain: (env: NodeJS.ProcessEnv) => { node: string | null; npx: string | null }
  /** Working directory for the child (never a project folder). */
  cwd: string
  /** `computer-<scope>` for this user and control plane, when computable. */
  computerInstance?: () => Promise<string | null>
  /** Called on success with the service instance 20x itself started, to remember it. */
  recordConnection?: (record: ConnectionRecord) => void
  /** Kill a whole process group (the child is detached). Defaults to process.kill(-pid). */
  killGroup?: (pid: number, signal: NodeJS.Signals) => void
  /** SIGTERM → SIGKILL delay, then the forced `finish`. */
  graceMs?: number
}

const MAX_LINES = 200
const DEFAULT_TIMEOUT_MS = 35 * 60_000
/** Only these hosts may be opened for approval. */
const APPROVAL_HOSTS = /^(?:app|stage-app|stage)\.peakflo\.ai$|^localhost$|^127\.0\.0\.1$/

function emptySteps(): Record<ConnectStepId, ConnectStepState> {
  return { connection: 'pending', approve: 'pending', register: 'pending', service: 'pending' }
}

/**
 * Runs `npx @peakflo/agent-harness@<pinned> connect …` and turns its output
 * into progress. One run at a time.
 *
 * No token can reach the child: 20x only ever holds the connection UUID, the
 * environment is an allowlist, and every line is redacted before it is kept,
 * shown or logged.
 */
export class ConnectRunner {
  private current: {
    progress: ConnectProgress
    child: ChildProcess | null
    approveUrl: string | null
    parser: ConnectOutputParser
    errorLines: string[]
    successSeen: boolean
    cancelled: boolean
    timer: ReturnType<typeof setTimeout> | null
    killTimer: ReturnType<typeof setTimeout> | null
    spawnError: string | null
    finished: boolean
    logPath: string
    instance: string | null
    controlPlane: string
  } | null = null
  /** Set synchronously on entry to start(), so two calls cannot both pass the checks. */
  private starting = false

  constructor(private readonly deps: ConnectRunnerDeps) {}

  getProgress(runId?: string): ConnectProgress | null {
    if (!this.current) return null
    if (runId && this.current.progress.runId !== runId) return null
    return this.current.progress
  }

  async start(request: StartConnectRequest): Promise<StartConnectResult> {
    if (this.starting || (this.current && !this.current.finished)) {
      return { ok: false, failure: { kind: 'unknown', message: 'A connection is already in progress.' } }
    }
    this.starting = true
    try {
      return await this.startInner(request)
    } finally {
      this.starting = false
    }
  }

  private async startInner(request: StartConnectRequest): Promise<StartConnectResult> {
    const platform = this.deps.platform
    if (platform !== 'darwin' && platform !== 'linux') {
      return {
        ok: false,
        failure: { kind: 'unsupported_os', message: 'Runners need macOS or Linux. Use a Mac/Linux machine or a shared runner.' }
      }
    }
    if (request.replacesRunnerId !== undefined && !isUuid(request.replacesRunnerId)) {
      return { ok: false, failure: { kind: 'unknown', message: 'The machine id is invalid.' } }
    }
    let command
    let connectionId: string
    try {
      const info = await this.deps.api.getHarnessVersion()
      if (!info.version) {
        return {
          ok: false,
          failure: { kind: 'version_unavailable', message: 'The server has not published a harness version yet. Try again later.' }
        }
      }
      const vendors: ConnectVendor[] = request.vendor === 'all' ? [...CONNECT_VENDORS] : [request.vendor]
      const connection = await this.deps.api.createConnection(vendors, request.replacesRunnerId)
      connectionId = connection.connectionId
      command = buildConnectCommand({
        version: info.version,
        vendor: request.vendor === 'all' ? null : request.vendor,
        connectionId,
        controlPlane: this.deps.api.getApiUrl(),
        ask: request.ask
      })
    } catch (error) {
      if (error instanceof ConnectCommandError) {
        return { ok: false, failure: { kind: 'unknown', message: error.message } }
      }
      const failure = toFailure(error)
      const rateLimited = /too many connection attempts/i.test(failure.message)
      return {
        ok: false,
        failure: {
          kind:
            failure.kind === 'not_signed_in'
              ? 'not_signed_in'
              : failure.kind === 'permission_denied'
                ? 'permission_denied'
                : rateLimited
                  ? 'rate_limited'
                  : 'unknown',
          message: redactSecrets(failure.message)
        }
      }
    }

    const tools = this.deps.resolveToolchain(this.deps.parentEnv ?? process.env)
    if (!tools.npx) {
      return {
        ok: false,
        failure: {
          kind: 'node_missing',
          message: 'npx (npm) was not found, so the connect command cannot run.',
          help: this.deps.platform === 'darwin' ? 'brew install node' : 'Install Node.js (with npm) from nodejs.org, then re-check.'
        }
      }
    }
    const npxPath = tools.npx
    const instance = request.vendor === 'all' ? await this.deps.computerInstance?.().catch(() => null) ?? null : request.vendor
    const logPath = serviceLogPath(instance)
    const runId = this.deps.newId ? this.deps.newId() : `run_${Date.now().toString(36)}`
    const progress: ConnectProgress = {
      runId,
      phase: 'running',
      steps: { ...emptySteps(), connection: 'done' },
      lines: [],
      approveUrl: null,
      machineName: null,
      company: null,
      harnessesConnected: [],
      failure: null,
      commandDisplay: command.display
    }
    const state: NonNullable<ConnectRunner['current']> = {
      progress,
      child: null,
      approveUrl: null,
      parser: new ConnectOutputParser(),
      errorLines: [],
      successSeen: false,
      cancelled: false,
      timer: null,
      killTimer: null,
      spawnError: null,
      finished: false,
      logPath,
      instance,
      controlPlane: this.deps.api.getApiUrl()
    }
    this.current = state
    this.emit()

    try {
      // argv holds the pinned package and a UUID; env is an allowlist.
      // `npx` is the absolute path next to the node we checked, the child runs
      // from the home directory (never a project folder with its own .npmrc)
      // and in its own process group so Cancel/quit can stop the whole tree.
      const child = this.deps.spawn(npxPath, command.args, {
        env: buildCleanEnv(this.deps.parentEnv, [npxPath.slice(0, npxPath.lastIndexOf('/'))]),
        cwd: this.deps.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        detached: true,
        windowsHide: true
      })
      state.child = child
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => this.handle(state, state.parser.feed('stdout', chunk)))
      child.stderr?.on('data', (chunk: string) => this.handle(state, state.parser.feed('stderr', chunk)))
      child.on('error', (error) => {
        state.spawnError = error.message
        this.finish(state, null)
      })
      child.on('close', (code) => this.finish(state, code))
      state.timer = setTimeout(() => {
        state.errorLines.push('Timed out waiting for approval in the browser.')
        this.terminate(state)
      }, this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    } catch (error) {
      state.spawnError = error instanceof Error ? error.message : String(error)
      this.finish(state, null)
    }
    return { ok: true, runId }
  }

  /** True once register or service has started: the machine may be partly set up. */
  isPastPointOfNoReturn(): boolean {
    const p = this.current?.progress
    return !!p && p.phase === 'running' && (p.steps.register !== 'pending' || p.steps.service !== 'pending')
  }

  cancel(runId?: string): void {
    const state = this.current
    if (!state || state.finished) return
    if (runId && state.progress.runId !== runId) return
    state.cancelled = true
    this.terminate(state)
  }

  /** Stop the child on app quit. Synchronous: the app is exiting. */
  shutdown(): void {
    const state = this.current
    if (!state || state.finished) return
    state.cancelled = true
    this.signal(state, 'SIGTERM')
  }

  private signal(state: NonNullable<ConnectRunner['current']>, signal: NodeJS.Signals): void {
    const child = state.child
    if (!child) return
    try {
      if (child.pid && this.deps.platform !== 'win32') {
        ;(this.deps.killGroup ?? ((pid, sig) => process.kill(-pid, sig)))(child.pid, signal)
      } else {
        child.kill(signal)
      }
    } catch {
      try {
        child.kill(signal)
      } catch {
        /* already gone */
      }
    }
  }

  /** SIGTERM now, SIGKILL after the grace period, and `finish` even if `close` never comes. */
  private terminate(state: NonNullable<ConnectRunner['current']>): void {
    if (!state.child) {
      this.finish(state, null)
      return
    }
    this.signal(state, 'SIGTERM')
    if (state.killTimer) return
    const grace = this.deps.graceMs ?? 5000
    state.killTimer = setTimeout(() => {
      if (state.finished) return
      this.signal(state, 'SIGKILL')
      state.killTimer = setTimeout(() => this.finish(state, null), Math.min(grace, 2000))
    }, grace)
  }

  /** Re-open the approval page the CLI printed. Only Peakflo (or localhost) pages. */
  async openApprovalPage(runId: string): Promise<boolean> {
    const state = this.current
    if (!state || state.progress.runId !== runId || !state.approveUrl) return false
    try {
      const url = new URL(state.approveUrl)
      if (!APPROVAL_HOSTS.test(url.hostname) || url.pathname !== '/connect-computer') return false
      if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return false
      await this.deps.openExternal(url.toString())
      return true
    } catch {
      return false
    }
  }

  private emit(): void {
    const state = this.current
    if (!state) return
    // A copy: the renderer must never hold the live object.
    this.deps.onProgress(JSON.parse(JSON.stringify(state.progress)) as ConnectProgress)
  }

  private handle(state: NonNullable<ConnectRunner['current']>, events: ConnectEvent[]): void {
    if (state.finished || events.length === 0) return
    const p = state.progress
    for (const event of events) {
      switch (event.type) {
        case 'line':
          p.lines.push(event.text)
          if (p.lines.length > MAX_LINES) p.lines.splice(0, p.lines.length - MAX_LINES)
          this.deps.log?.(`[connect-computer] ${event.text}`)
          break
        case 'step':
          // Steps only move forward.
          if (p.steps[event.id] !== 'done' || event.state === 'done') p.steps[event.id] = event.state
          break
        case 'approve-url':
          state.approveUrl = event.url
          p.approveUrl = sanitiseApproveUrl(event.url)
          break
        case 'machine':
          p.machineName = event.name
          break
        case 'company':
          p.company = event.name
          break
        case 'harness-added':
          if (!p.harnessesConnected.includes(event.name)) p.harnessesConnected.push(event.name)
          break
        case 'error-line':
          state.errorLines.push(event.text)
          break
        case 'success':
          state.successSeen = true
          break
      }
    }
    this.emit()
  }

  private finish(state: NonNullable<ConnectRunner['current']>, code: number | null): void {
    if (state.finished) return
    if (state.timer) clearTimeout(state.timer)
    if (state.killTimer) clearTimeout(state.killTimer)
    // Last partial lines first, while handle() still accepts events.
    this.handle(state, state.parser.flush())
    state.finished = true
    const p = state.progress
    if (state.cancelled) {
      p.phase = 'cancelled'
      const partial = p.steps.register !== 'pending' || p.steps.service !== 'pending'
      p.failure = partial
        ? {
            kind: 'cancelled_partial',
            message:
              'Cancelled while setting up. This computer may be partly connected: use Reconnect on the machine, or run the uninstall command from Remove machine.',
            logPath: state.logPath
          }
        : { kind: 'denied', message: 'Connection cancelled. Nothing was installed on this computer.' }
      this.emit()
      return
    }
    if (state.successSeen && (code === 0 || code === null)) {
      p.phase = 'success'
      if (state.instance) {
        try {
          this.deps.recordConnection?.({ instance: state.instance, machineName: p.machineName, controlPlane: state.controlPlane, connectedAt: Date.now() })
        } catch {
          /* remembering is best effort */
        }
      }
      this.emit()
      this.deps.onConnected?.()
      return
    }
    const activeStep = (Object.keys(p.steps) as ConnectStepId[]).find((id) => p.steps[id] === 'active') ?? null
    const failure: ConnectFailure = classifyFailure({
      errorText: state.errorLines.join('\n'),
      exitCode: code,
      spawnError: state.spawnError,
      platform: this.deps.platform,
      activeStep,
      logPath: state.logPath
    })
    if (activeStep) p.steps[activeStep] = 'failed'
    p.phase = 'failed'
    p.failure = failure
    this.emit()
  }
}
