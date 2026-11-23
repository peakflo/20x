/**
 * Enterprise runners ("Machines") — types and pure logic shared by the main
 * process, the renderer and the mobile read-only list.
 *
 * Nothing here touches the network, the file system or Electron.
 */

// ── Vendors / connect command ─────────────────────────────────────

export const CONNECT_VENDORS = ['claude-code', 'codex', 'cursor'] as const
export type ConnectVendor = (typeof CONNECT_VENDORS)[number]
/** "All detected" connects every usable harness (no vendor argument). */
export type HarnessChoice = 'all' | ConnectVendor

export const CONNECT_VENDOR_LABELS: Record<ConnectVendor, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor'
}

export const HARNESS_PACKAGE = '@peakflo/agent-harness'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Final releases and release candidates, as published by the pipeline. */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

export function isPublishedHarnessVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_RE.test(value)
}

export class ConnectCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectCommandError'
  }
}

export interface ConnectCommandInput {
  /** The server-pinned harness version (never "latest"). */
  version: string
  /** Absent = "All detected": every usable harness. */
  vendor?: ConnectVendor | null
  /** One-time connection id (a UUID). The only credential-like value in argv. */
  connectionId: string
  /** The API base URL for the environment (local / stage / production). */
  controlPlane: string
  /** `--ask`: confirm each harness. Only valid without a vendor. */
  ask?: boolean
}

export interface ConnectCommand {
  command: 'npx'
  args: string[]
  /** Human-readable form for the preview. Contains nothing that is not in args. */
  display: string
}

/**
 * Build the `npx` invocation for "Connect this computer".
 *
 * Invariants (each has a test):
 * - runs the published package at the pinned version, so it always matches the
 *   server and nothing is bundled in 20x;
 * - `--connection` is a UUID: no token, no free-form value;
 * - `--ask` is refused when a vendor is picked;
 * - `--all` is never emitted (it is only an alias for the default);
 * - `--token` is never emitted.
 */
export function buildConnectCommand(input: ConnectCommandInput): ConnectCommand {
  if (!isPublishedHarnessVersion(input.version)) {
    throw new ConnectCommandError('The server has not published a harness version to connect with yet.')
  }
  if (!isUuid(input.connectionId)) {
    throw new ConnectCommandError('The connection id must be a UUID.')
  }
  let controlPlane: URL
  try {
    controlPlane = new URL(input.controlPlane)
  } catch {
    throw new ConnectCommandError('The control-plane URL is invalid.')
  }
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(controlPlane.hostname)
  if (controlPlane.protocol !== 'https:' && !(controlPlane.protocol === 'http:' && isLoopback)) {
    throw new ConnectCommandError('The control-plane URL must use HTTPS (or HTTP on this computer).')
  }
  if (controlPlane.username || controlPlane.password || controlPlane.search || controlPlane.hash) {
    throw new ConnectCommandError('The control-plane URL must not carry credentials or a query.')
  }
  const vendor = input.vendor ?? null
  if (vendor !== null && !CONNECT_VENDORS.includes(vendor)) {
    throw new ConnectCommandError('Choose Claude Code, Codex or Cursor, or connect all detected harnesses.')
  }
  if (vendor !== null && input.ask) {
    throw new ConnectCommandError('"Ask before actions" only applies to "All detected".')
  }

  const args = ['--yes', `${HARNESS_PACKAGE}@${input.version}`, 'connect']
  if (vendor) args.push(vendor)
  if (input.ask) args.push('--ask')
  args.push('--connection', input.connectionId, '--control-plane', controlPlane.origin)
  return { command: 'npx', args, display: `npx ${args.join(' ')}` }
}

/** The command as previewed before a connection exists. The id is a placeholder, never real. */
export function previewConnectCommand(input: Omit<ConnectCommandInput, 'connectionId'>): string {
  const nil = '00000000-0000-0000-0000-000000000000'
  return buildConnectCommand({ ...input, connectionId: nil }).display.replace(nil, '<connection-id>')
}

const SERVICE_INSTANCE_RE = /^(?:claude-code|codex|cursor|computer-[a-f0-9]{24})$/

export function isServiceInstance(value: unknown): value is string {
  return typeof value === 'string' && SERVICE_INSTANCE_RE.test(value)
}

/**
 * `connect` installs one service per instance (`ai.peakflo.agent-harness.<instance>` /
 * `pf-agent-harness-<instance>.service`). `service uninstall` without `--vendor`
 * only targets the base service, so the instance is always named.
 */
export function buildUninstallCommand(version: string | null, instance: string): string {
  if (!isServiceInstance(instance)) throw new ConnectCommandError('Unknown service instance.')
  const pkg = isPublishedHarnessVersion(version) ? `${HARNESS_PACKAGE}@${version}` : HARNESS_PACKAGE
  return `npx --yes ${pkg} service uninstall --vendor ${instance}`
}

export interface UninstallPlan {
  commands: string[]
  /** Set when the exact service could not be determined. */
  note: string | null
}

/** One command per installed service; an honest note when the instance is unknown. */
export function buildUninstallPlan(version: string | null, instances: readonly string[]): UninstallPlan {
  const valid = Array.from(new Set(instances.filter(isServiceInstance)))
  if (valid.length > 0) return { commands: valid.map((i) => buildUninstallCommand(version, i)), note: null }
  return {
    commands: [],
    note:
      'The background service on that computer could not be identified from here. On that computer run ' +
      `\`npx --yes ${HARNESS_PACKAGE} service status\` to see its name, then uninstall it with ` +
      '`service uninstall --vendor <name>`. Without --vendor, uninstall only removes the base service, not the one connect installed.'
  }
}

/** Where connect-installed services write logs (macOS and Linux). */
export function serviceLogPath(instance: string | null): string {
  return isServiceInstance(instance) ? `~/.pf-agent-harness/logs/${instance}` : '~/.pf-agent-harness/logs'
}

// ── Redaction ─────────────────────────────────────────────────────

const REDACTED = '[redacted]'
/** Query / form parameters that carry one-time secrets. */
const SECRET_PARAMS = /([?&](?:state|challenge|code|code_verifier|codeVerifier|token|access_token|refresh_token|enrolmentToken|key|secret|password)=)[^&\s"']+/gi
const TOKEN_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // JWTs (three base64url segments).
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g,
  // Vendor-style keys: sk-..., ghp_..., xoxb-..., pf_..., etc.
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|github_pat|xox[abprs]|glpat)[-_][A-Za-z0-9_-]{16,}/g,
  /\b(?:enrol|enrolment|runner)[-_]?(?:token|credential)[=:]\s*\S+/gi,
  // key=value assignments with a secret-ish name.
  /\b(?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*\S+/g,
  // Long opaque base64url / hex runs (PKCE verifiers, codes, hashes).
  /\b[A-Za-z0-9_-]{43,}\b/g
]

/**
 * Remove anything token-like from text before it is shown, logged or stored.
 * The connection UUID is not a secret (it is the only value that is meant to
 * appear in argv) and is kept so people can recognise the connection.
 */
export function redactSecrets(text: string): string {
  let out = text.replace(SECRET_PARAMS, `$1${REDACTED}`)
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, (match) => (isUuid(match) || /agent-harness/.test(match) ? match : REDACTED))
  }
  return out
}

// ── Version comparison ────────────────────────────────────────────

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  rc: number | null
}

function parseVersion(value: string | null | undefined): ParsedVersion | null {
  if (!value) return null
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(value.trim())
  if (!match) return null
  return { major: +match[1], minor: +match[2], patch: +match[3], rc: match[4] === undefined ? null : +match[4] }
}

/** Negative when a < b. `null` when either side is not a published version. */
export function compareHarnessVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return null
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (x[key] !== y[key]) return x[key] - y[key]
  }
  // A release candidate sorts before its final.
  if (x.rc === y.rc) return 0
  if (x.rc === null) return 1
  if (y.rc === null) return -1
  return x.rc - y.rc
}

interface Partial3 {
  major: number
  minor: number | null
  patch: number | null
}

function parsePartial(value: string): Partial3 | null {
  const match = /^v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i.exec(value.trim())
  if (!match || /^[x*]$/i.test(match[1])) return null
  const num = (v: string | undefined): number | null => (v !== undefined && /^\d+$/.test(v) ? +v : null)
  return { major: +match[1], minor: num(match[2]), patch: num(match[3]) }
}

type Triple = [number, number, number]
const cmp = (a: Triple, b: Triple): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
const floor = (p: Partial3): Triple => [p.major, p.minor ?? 0, p.patch ?? 0]
/** The first version above everything the partial covers: 22 → 23.0.0, 22.4 → 22.5.0, 22.4.1 → 22.4.2. */
const ceil = (p: Partial3): Triple =>
  p.minor === null ? [p.major + 1, 0, 0] : p.patch === null ? [p.major, p.minor + 1, 0] : [p.major, p.minor, p.patch + 1]

/**
 * Does `version` satisfy a Node `engines` range such as
 * `^22.23.5 || ^24.22.3 || >=26.13.1 <27`? Supports `||`, `^`, `~`, `>=`, `>`,
 * `<=`, `<`, `=`, bare/partial versions (`22`, `22.x`, `~22`), `*`, and spaces
 * between an operator and its version (`>= 24`). A range that cannot be parsed
 * at all is treated as satisfied: the CLI makes its own check.
 */
export function satisfiesNodeRange(version: string, range: string | null | undefined): boolean {
  const current = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (!current) return false
  const v: Triple = [+current[1], +current[2], +current[3]]
  if (!range || !range.trim()) return true
  for (const alt of range.split('||')) {
    const tokens = alt
      .trim()
      .replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1')
      .split(/\s+/)
      .filter(Boolean)
    if (tokens.length === 0 || tokens.every((t) => t === '*' || /^x$/i.test(t))) return true
    let ok = true
    for (const token of tokens) {
      const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token)
      if (!match) return true
      if (/^[x*]$/i.test(match[2])) continue
      const p = parsePartial(match[2])
      if (!p) return true
      let pass: boolean
      switch (match[1] ?? '=') {
        case '^': {
          const upper: Triple =
            p.major > 0 ? [p.major + 1, 0, 0] : (p.minor ?? 0) > 0 || p.patch === null ? [0, (p.minor ?? 0) + 1, 0] : [0, 0, (p.patch ?? 0) + 1]
          pass = cmp(v, floor(p)) >= 0 && cmp(v, upper) < 0
          break
        }
        case '~':
          pass = cmp(v, floor(p)) >= 0 && cmp(v, p.minor === null ? [p.major + 1, 0, 0] : [p.major, p.minor + 1, 0]) < 0
          break
        case '>=':
          pass = cmp(v, floor(p)) >= 0
          break
        case '>':
          pass = cmp(v, ceil(p)) >= 0
          break
        case '<=':
          pass = cmp(v, ceil(p)) < 0
          break
        case '<':
          pass = cmp(v, floor(p)) < 0
          break
        default:
          pass = cmp(v, floor(p)) >= 0 && cmp(v, ceil(p)) < 0
      }
      if (!pass) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

// ── Machines ──────────────────────────────────────────────────────

export type MachineStatus = 'online' | 'busy' | 'offline' | 'refused'
export type MachineScope = 'mine' | 'shared'

/**
 * - `up_to_date`: nothing to do.
 * - `update_available`: warn only. The machine keeps working.
 * - `refused`: the server answered 426 (protocol too old). The runner takes no
 *   work. The service updates itself and rejoins; Update is the manual fallback.
 * - `unknown`: the server did not say.
 */
export type VersionStateKind = 'up_to_date' | 'update_available' | 'refused' | 'unknown'

export interface VersionState {
  kind: VersionStateKind
  /** The version the server recommends / the machine will move to. */
  target: string | null
  reason: string | null
  /** True when an update is already in progress (`update.state === 'updating'`). */
  updating: boolean
}

export interface MachineUpdateInfo {
  supported: boolean
  selfUpdate: boolean
  available: boolean
  targetVersion: string | null
  state: 'updating' | 'updated' | 'failed' | 'rolled_back' | 'refused' | null
  reason: string | null
  nowRequested: boolean
}

export interface MachinePinnedAgent {
  id: string
  name: string
  backend: string
}

export interface MachineRow {
  id: string
  name: string
  scope: MachineScope
  /** `os · arch` as reported by the runner, when known. */
  platform: string | null
  /** The machine this 20x runs on (best effort, matched by host name). */
  thisComputer: boolean
  status: MachineStatus
  lastSeenAt: string | null
  version: string | null
  versionState: VersionState
  harnesses: string[]
  pinnedAgents: MachinePinnedAgent[]
  ownerName: string | null
  activeSessions: number | null
  maxSessions: number | null
  /** Rename / Remove / Update are only offered when the server says so. */
  canManage: boolean
  /** The server's own reason a row cannot take work right now. */
  unavailableReason: string | null
  update: MachineUpdateInfo | null
  /** Service instances `connect` installed on that computer (for the uninstall command). */
  serviceInstances: string[]
}

export interface MachinesSnapshot {
  fetchedAt: number
  /** The server-pinned harness version (null when the server has none yet). */
  pinnedVersion: string | null
  nodeEngines: string | null
  machines: MachineRow[]
}

export type MachinesErrorKind = 'not_signed_in' | 'permission_denied' | 'unavailable'

export interface MachinesFailure {
  kind: MachinesErrorKind
  message: string
}

export type MachinesResult =
  | { ok: true; snapshot: MachinesSnapshot }
  | { ok: false; error: MachinesFailure }

export type MachineActionResult = { ok: true } | { ok: false; error: MachinesFailure }

// ── Raw server shapes (defensive; every field optional) ───────────

export interface RawByoMachine {
  runnerId?: string
  name?: string
  personal?: boolean
  isOwner?: boolean
  ownerName?: string | null
  canManage?: boolean
  online?: boolean
  registered?: boolean
  status?: string
  harnessVersion?: string | null
  lastSeenAt?: string | null
  vendors?: string[]
  /** The service instance the server knows for this machine (preferred over a local guess). */
  serviceInstance?: string | null
  discovery?: boolean
  harnesses?: Array<{ name?: string; usable?: boolean; installed?: boolean | null }>
  agents?: Array<{ agentId?: string; name?: string; backend?: string }>
  update?: Partial<MachineUpdateInfo> & { autoUpdate?: boolean }
}

export interface RawRunner {
  id?: string
  name?: string
  personal?: boolean
  canSelect?: boolean
  status?: string
  runtime?: string
  harnessVersion?: string | null
  protocolVersion?: number | string | null
  degraded?: boolean
  degradedReason?: string | null
  lastHeartbeatAt?: string | null
  capabilities?: {
    os?: string
    arch?: string
    hostname?: string
    backends?: Array<{ name?: string } | string>
    vendorHarnesses?: string[]
  } | null
  selectable?: boolean
  unselectableReason?: string | null
  unselectableLabel?: string | null
  activeSessionCount?: number
  maxConcurrentSessions?: number
}

const OS_LABELS: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }

const REFUSED_REASON = /protocol|426|refus|too old|floor/i

/** Heartbeat older than this and the server has not marked it offline yet. */
export const STALE_HEARTBEAT_MS = 5 * 60_000

export function deriveVersionState(input: {
  version: string | null
  update: MachineUpdateInfo | null
  refused: boolean
  pinnedVersion: string | null
}): VersionState {
  const updating = input.update?.state === 'updating'
  if (input.refused || input.update?.state === 'refused') {
    return {
      kind: 'refused',
      target: input.update?.targetVersion ?? input.pinnedVersion,
      reason: input.update?.reason ?? null,
      updating
    }
  }
  if (input.update?.available) {
    return { kind: 'update_available', target: input.update.targetVersion, reason: null, updating }
  }
  // Fall back to the pin when the server did not compute an update decision.
  if (!input.update && input.pinnedVersion && input.version) {
    const cmp = compareHarnessVersions(input.version, input.pinnedVersion)
    if (cmp !== null && cmp < 0) {
      return { kind: 'update_available', target: input.pinnedVersion, reason: null, updating }
    }
    if (cmp !== null) return { kind: 'up_to_date', target: input.pinnedVersion, reason: null, updating }
  }
  if (!input.version) return { kind: 'unknown', target: null, reason: null, updating }
  return { kind: 'up_to_date', target: input.update?.targetVersion ?? null, reason: null, updating }
}

function normaliseUpdate(raw: RawByoMachine['update']): MachineUpdateInfo | null {
  if (!raw) return null
  return {
    supported: raw.supported !== false,
    selfUpdate: raw.selfUpdate === true,
    available: raw.available === true,
    targetVersion: raw.targetVersion ?? null,
    state: raw.state ?? null,
    reason: raw.reason ?? null,
    nowRequested: raw.nowRequested === true
  }
}

function backendNames(runner: RawRunner | undefined): string[] {
  const caps = runner?.capabilities
  if (!caps) return []
  const names = (caps.backends ?? [])
    .map((b) => (typeof b === 'string' ? b : b?.name))
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
  return Array.from(new Set(names))
}

function statusOf(
  machine: RawByoMachine | undefined,
  runner: RawRunner | undefined,
  refused: boolean,
  now: number
): MachineStatus {
  if (refused) return 'refused'
  const raw = (runner?.status ?? machine?.status ?? '').toLowerCase()
  const lastSeen = runner?.lastHeartbeatAt ?? machine?.lastSeenAt ?? null
  const stale = lastSeen ? now - Date.parse(lastSeen) > STALE_HEARTBEAT_MS : false
  if (raw === 'offline' || raw === 'deregistered' || machine?.online === false || stale) return 'offline'
  const active = runner?.activeSessionCount ?? 0
  if (raw === 'busy' || raw === 'draining' || active > 0) return 'busy'
  return 'online'
}

function serviceInstancesOf(machine: RawByoMachine | undefined, computerInstance: string | null): string[] {
  if (!machine) return []
  if (isServiceInstance(machine.serviceInstance)) return [machine.serviceInstance]
  if (machine.discovery === true) return computerInstance && machine.isOwner !== false ? [computerInstance] : []
  return (machine.vendors ?? []).filter(isServiceInstance)
}

export interface NormaliseOptions {
  machines: RawByoMachine[] | null
  runners: RawRunner[] | null
  pinnedVersion: string | null
  /** Used to flag "this computer". */
  hostname?: string | null
  now?: number
  /** `computer-<scope>` for the signed-in user on this control plane, when computable. */
  computerInstance?: string | null
}

function sameHost(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const strip = (v: string) => v.toLowerCase().replace(/\.local$/, '')
  return strip(a) === strip(b)
}

/**
 * Merge `GET /byo/machines` (mine: update decision, pinned agents, who can
 * manage) with `GET /coding-agents/runners` (everything the tenant offers:
 * liveness verdict, sessions, backends). Rows the user cannot use are dropped:
 * another person's personal machine is not shown.
 */
export function normaliseMachines(options: NormaliseOptions): MachineRow[] {
  const now = options.now ?? Date.now()
  const byRunner = new Map<string, RawRunner>()
  for (const runner of options.runners ?? []) if (runner.id) byRunner.set(runner.id, runner)
  const seen = new Set<string>()
  const rows: MachineRow[] = []

  const build = (id: string, machine: RawByoMachine | undefined, runner: RawRunner | undefined): void => {
    const personal = machine?.personal ?? runner?.personal ?? false
    const isOwner = machine?.isOwner ?? (runner ? runner.canSelect === true && personal : false)
    // Someone else's personal machine is not ours to list.
    if (personal && !isOwner) return
    const name = machine?.name ?? runner?.name ?? 'Unnamed machine'
    const update = normaliseUpdate(machine?.update)
    const unavailableReason = runner?.unselectableReason ?? null
    const refused =
      update?.state === 'refused' ||
      (runner?.selectable === false && REFUSED_REASON.test(`${unavailableReason ?? ''} ${runner.unselectableLabel ?? ''}`))
    const version = machine?.harnessVersion ?? runner?.harnessVersion ?? null
    const fromMachines = (machine?.harnesses ?? [])
      .filter((h) => h?.name && h.installed !== false)
      .map((h) => h.name as string)
    const harnesses = Array.from(new Set([...backendNames(runner), ...fromMachines, ...(machine?.vendors ?? [])]))
    const os = runner?.capabilities?.os
    const platform = os
      ? [OS_LABELS[os] ?? os, runner?.capabilities?.arch].filter(Boolean).join(' · ')
      : null
    rows.push({
      id,
      name,
      scope: personal ? 'mine' : 'shared',
      platform,
      thisComputer: personal && sameHost(options.hostname, runner?.capabilities?.hostname ?? name),
      status: statusOf(machine, runner, refused, now),
      lastSeenAt: runner?.lastHeartbeatAt ?? machine?.lastSeenAt ?? null,
      version,
      versionState: deriveVersionState({ version, update, refused, pinnedVersion: options.pinnedVersion }),
      harnesses,
      pinnedAgents: (machine?.agents ?? [])
        .filter((a) => a.agentId)
        .map((a) => ({ id: a.agentId as string, name: a.name ?? 'Agent', backend: a.backend ?? '' })),
      ownerName: machine?.ownerName ?? null,
      activeSessions: runner?.activeSessionCount ?? null,
      maxSessions: runner?.maxConcurrentSessions ?? null,
      canManage: machine?.canManage === true,
      unavailableReason,
      update,
      serviceInstances: serviceInstancesOf(machine, options.computerInstance ?? null)
    })
  }

  for (const machine of options.machines ?? []) {
    if (!machine.runnerId || machine.registered === false) continue
    seen.add(machine.runnerId)
    build(machine.runnerId, machine, byRunner.get(machine.runnerId))
  }
  for (const [id, runner] of byRunner) {
    if (seen.has(id)) continue
    build(id, undefined, runner)
  }

  const order = { mine: 0, shared: 1 } as const
  return rows.sort(
    (a, b) =>
      order[a.scope] - order[b.scope] ||
      Number(b.status === 'online' || b.status === 'busy') - Number(a.status === 'online' || a.status === 'busy') ||
      a.name.localeCompare(b.name)
  )
}

/** Machines whose service should be updated by "Update all". */
export function machinesNeedingUpdate(rows: MachineRow[]): MachineRow[] {
  return rows.filter(
    (row) =>
      row.canManage &&
      row.scope === 'mine' &&
      (row.versionState.kind === 'update_available' || row.versionState.kind === 'refused') &&
      !row.versionState.updating &&
      row.update?.supported !== false
  )
}

// ── Connect flow types ────────────────────────────────────────────

export type ConnectStepId = 'connection' | 'approve' | 'register' | 'service'
export type ConnectStepState = 'pending' | 'active' | 'done' | 'failed'

export const CONNECT_STEPS: { id: ConnectStepId; label: string }[] = [
  { id: 'connection', label: 'Connection' },
  { id: 'approve', label: 'Approve' },
  { id: 'register', label: 'Register' },
  { id: 'service', label: 'Service' }
]

export type ConnectFailureKind =
  | 'unsupported_os'
  | 'not_signed_in'
  | 'permission_denied'
  | 'version_unavailable'
  | 'node_missing'
  | 'git_missing'
  | 'denied'
  | 'expired'
  | 'service_failed'
  | 'vendor_missing'
  | 'rate_limited'
  | 'cancelled_partial'
  | 'unknown'

export interface ConnectFailure {
  kind: ConnectFailureKind
  message: string
  /** Where to look for the service log (service failures). */
  logPath?: string
  /** A fixed, copyable hint (for example `brew install node`). */
  help?: string
}

export interface PreflightCheck {
  id: 'os' | 'node' | 'npx' | 'git' | 'signed_in'
  ok: boolean
  /** What was found, for display ("Node 22.4.0", "macOS 15 arm64"). */
  detail: string
  help?: string
}

export interface PreflightResult {
  ok: boolean
  checks: PreflightCheck[]
  /** Set when the server has published no harness version. */
  versionError: string | null
  pinnedVersion: string | null
  nodeEngines: string | null
  /** The API base URL the command will pass as --control-plane. */
  controlPlane: string | null
  failure: ConnectFailure | null
}

export type ConnectPhase = 'idle' | 'running' | 'success' | 'failed' | 'cancelled'

export interface ConnectProgress {
  runId: string
  phase: ConnectPhase
  steps: Record<ConnectStepId, ConnectStepState>
  /** Redacted CLI output (bounded). */
  lines: string[]
  /** The browser approval URL with one-time parameters stripped. */
  approveUrl: string | null
  machineName: string | null
  company: string | null
  harnessesConnected: string[]
  failure: ConnectFailure | null
  /** Shown to the user as the exact command that ran. Contains only a UUID. */
  commandDisplay: string
}

export interface StartConnectRequest {
  vendor: HarnessChoice
  ask: boolean
  /** Reconnect: the server re-pins this machine's agents to the new connection. */
  replacesRunnerId?: string
}

export type StartConnectResult =
  | { ok: true; runId: string }
  | { ok: false; failure: ConnectFailure }
