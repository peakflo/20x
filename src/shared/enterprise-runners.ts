/**
 * Shared contract for Spaces enterprise runners (main, renderer and mobile).
 *
 * Pure types and pure functions only: no Electron, no fetch. The server owns
 * every verdict (which runner is selectable, what a permission limit is, when a
 * task is complete); this file only normalises what the server sends and
 * derives display state from it.
 */

/** `config.coding_agent` value of a `[Workflo]` agent that runs on a runner. */
export const ENTERPRISE_RUNNER_AGENT_TYPE = 'enterprise-runner'

/** Unanswered approvals and questions are auto-denied after this long. */
export const APPROVAL_TTL_MS = 30 * 60 * 1000

/** Harness names a runner can report, as the server spells them. */
export type RunnerHarnessName = 'claude-code' | 'codex' | 'cursor' | 'pi' | (string & {})

export const RUNNER_HARNESS_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  pi: 'Pi'
}

export function runnerHarnessLabel(name: string): string {
  return RUNNER_HARNESS_LABELS[name] ?? name
}

export type RunnerStatus = 'online' | 'busy' | 'offline' | 'refused'

export interface RunnerHarness {
  name: RunnerHarnessName
  version?: string
}

/** What `GET /api/coding-agents/runners` returns per runner (fields we read). */
export interface RawRunnerSummary {
  id: string
  name: string
  runtime?: string
  status?: string
  labels?: string[]
  capabilities?: Record<string, unknown>
  harnessVersion?: string | null
  protocolVersion?: number | null
  degraded?: boolean
  degradedReason?: string | null
  lastHeartbeatAt?: string | null
  deregisteredAt?: string | null
  selectable?: boolean
  unselectableReason?: string | null
  unselectableLabel?: string | null
  heartbeatAgeMs?: number | null
  activeSessionCount?: number
  maxConcurrentSessions?: number
  willEventuallyClaim?: boolean
  /** Present on newer servers: true when the runner belongs to the caller. */
  personal?: boolean
  canSelect?: boolean
}

export interface EnterpriseRunner {
  id: string
  name: string
  /** 'mine' = a personal machine of the signed-in user; 'shared' = tenant runner. */
  kind: 'mine' | 'shared'
  status: RunnerStatus
  harnesses: RunnerHarness[]
  activeSessionCount: number
  lastSeenAt: string | null
  version: string | null
  /** Server verdict: can take a turn right now (busy-but-claiming counts as yes). */
  selectable: boolean
  /** Server phrase, e.g. "not beating — last heartbeat 3h ago". */
  serverReason: string | null
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** Reads `capabilities.backends` ([{name, version}] or ['name']) defensively. */
export function readRunnerHarnesses(capabilities: Record<string, unknown> | undefined): RunnerHarness[] {
  const raw = capabilities?.backends
  if (!Array.isArray(raw)) return []
  const out: RunnerHarness[] = []
  for (const item of raw) {
    if (typeof item === 'string' && item) out.push({ name: item })
    else if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
      const o = item as { name: string; version?: unknown }
      out.push({ name: o.name, ...(typeof o.version === 'string' ? { version: o.version } : {}) })
    }
  }
  return out
}

export function toEnterpriseRunner(raw: RawRunnerSummary, now = Date.now()): EnterpriseRunner {
  const ageMs = raw.heartbeatAgeMs
    ?? (raw.lastHeartbeatAt ? Math.max(0, now - Date.parse(raw.lastHeartbeatAt)) : null)
  let status: RunnerStatus
  if (raw.unselectableReason === 'deregistered' || raw.unselectableReason === 'stale' || raw.unselectableReason === 'offline' || raw.deregisteredAt) {
    status = 'offline'
  } else if (raw.degraded && raw.degradedReason?.toLowerCase().includes('protocol')) {
    status = 'refused'
  } else if ((raw.activeSessionCount ?? 0) > 0 || raw.unselectableReason === 'at-capacity') {
    status = 'busy'
  } else if (raw.status === 'offline' || raw.status === 'stale' || (ageMs !== null && ageMs > 90_000)) {
    status = 'offline'
  } else {
    status = 'online'
  }
  const reason = raw.unselectableLabel
    ?? (raw.unselectableReason ? `Unavailable: ${raw.unselectableReason}` : null)
  return {
    id: raw.id,
    name: raw.name,
    kind: raw.personal === true ? 'mine' : 'shared',
    status,
    harnesses: readRunnerHarnesses(raw.capabilities),
    activeSessionCount: raw.activeSessionCount ?? 0,
    lastSeenAt: raw.lastHeartbeatAt ?? null,
    version: raw.harnessVersion ?? null,
    selectable: raw.selectable ?? (status === 'online' || status === 'busy'),
    serverReason: reason
  }
}

/** The harness an agent needs on a runner (server backend name), if known. */
export interface RunOnContext {
  signedIn: boolean
  hasPermission: boolean
  /** Server backend of the selected `[Workflo]` agent; null = not an enterprise agent. */
  agentBackend: string | null
  /** Agent has a runner pin: other runners are not usable. */
  agentPinnedRunnerId?: string | null
  now?: number
}

/**
 * Why a runner row is disabled in the "Run on" picker, or null when it can be
 * chosen. The server's own verdict (`selectable`) is authoritative; this adds
 * only the client-side facts the server does not know about (the agent
 * selected in the composer).
 */
export function runnerDisabledReason(runner: EnterpriseRunner, ctx: RunOnContext): string | null {
  if (!ctx.signedIn) return 'Sign in to Peakflo Enterprise to use runners'
  if (!ctx.hasPermission) return 'Permission denied · needs coding-agents:use'
  if (!ctx.agentBackend) return 'Select a [Workflo] agent to run on a runner'
  if (ctx.agentPinnedRunnerId && ctx.agentPinnedRunnerId !== runner.id) {
    return 'The selected agent is pinned to another runner'
  }
  if (runner.status === 'refused') return 'Runner is too old for this server (426) — update it'
  if (!runner.selectable) {
    if (runner.status === 'offline' && runner.lastSeenAt) {
      return `Offline ${formatAge((ctx.now ?? Date.now()) - Date.parse(runner.lastSeenAt))} — can’t start new sessions`
    }
    return runner.serverReason ?? 'Runner is unavailable'
  }
  if (runner.harnesses.length > 0 && !runner.harnesses.some((h) => h.name === ctx.agentBackend)) {
    return `Agent needs ${runnerHarnessLabel(ctx.agentBackend)} — not on this runner`
  }
  return null
}

export interface RunnerSections {
  mine: EnterpriseRunner[]
  shared: EnterpriseRunner[]
}

export function sectionRunners(runners: EnterpriseRunner[], query: string): RunnerSections {
  const q = query.trim().toLowerCase()
  const match = (r: EnterpriseRunner): boolean =>
    !q || r.name.toLowerCase().includes(q) || r.harnesses.some((h) => runnerHarnessLabel(h.name).toLowerCase().includes(q))
  const filtered = runners.filter(match)
  return { mine: filtered.filter((r) => r.kind === 'mine'), shared: filtered.filter((r) => r.kind === 'shared') }
}

// ── Run-on choice ────────────────────────────────────────────────────

export type RunOnChoice =
  | { kind: 'local' }
  | { kind: 'runner'; runnerId: string; runnerName: string }

export const RUN_ON_LOCAL: RunOnChoice = { kind: 'local' }

/** A session has started: the choice can no longer change. */
export function isRunOnLocked(sessionStarted: boolean): boolean {
  return sessionStarted
}

// ── Permission modes (narrow only) ───────────────────────────────────

export type RunnerPermissionMode = 'ask' | 'accept-edits' | 'bypass'

/** Narrowest first. */
export const RUNNER_PERMISSION_MODES: readonly RunnerPermissionMode[] = ['ask', 'accept-edits', 'bypass']

export const PERMISSION_LIMIT_TOOLTIP = 'Limited by your Spaces permissions'

export function normalizePermissionMode(value: string | null | undefined): RunnerPermissionMode {
  const v = (value ?? '').toLowerCase().replace(/[_\s]/g, '-')
  if (v === 'allow' || v === 'bypass' || v === 'bypasspermissions' || v === 'bypass-permissions') return 'bypass'
  if (v === 'accept-edits' || v === 'acceptedits') return 'accept-edits'
  return 'ask'
}

export interface PermissionModeOption {
  mode: RunnerPermissionMode
  label: string
  disabled: boolean
  tooltip: string | null
}

const PERMISSION_LABELS: Record<RunnerPermissionMode, string> = {
  ask: 'Ask for everything',
  'accept-edits': 'Accept edits',
  bypass: 'Bypass'
}

/** Modes above `limit` stay visible but disabled; a mode can only be narrowed. */
export function permissionModeOptions(limit: string | null | undefined): PermissionModeOption[] {
  const max = RUNNER_PERMISSION_MODES.indexOf(normalizePermissionMode(limit))
  return RUNNER_PERMISSION_MODES.map((mode, i) => ({
    mode,
    label: PERMISSION_LABELS[mode],
    disabled: i > max,
    tooltip: i > max ? PERMISSION_LIMIT_TOOLTIP : null
  }))
}

/** Clamp a chosen mode to the server limit (never widen). */
export function clampPermissionMode(chosen: string | null | undefined, limit: string | null | undefined): RunnerPermissionMode {
  const max = RUNNER_PERMISSION_MODES.indexOf(normalizePermissionMode(limit))
  const want = RUNNER_PERMISSION_MODES.indexOf(normalizePermissionMode(chosen ?? limit))
  return RUNNER_PERMISSION_MODES[Math.min(max, want)]
}

/** Server `permissionMode` that the client may send: only `ask` | `allow`. */
export function permissionModeToWire(mode: RunnerPermissionMode): 'ask' | 'allow' {
  return mode === 'ask' ? 'ask' : 'allow'
}

// ── Approvals ────────────────────────────────────────────────────────

export type ApprovalState = 'pending' | 'answered' | 'expired'

export interface ApprovalCountdown {
  state: ApprovalState
  remainingMs: number
  /** "27:40" */
  label: string
}

export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Countdown for an approval/question card. `requestedAtMs` is the part's
 * `createdAt`; an answered card never shows a countdown.
 */
export function approvalCountdown(requestedAtMs: number, answered: boolean, now = Date.now()): ApprovalCountdown {
  if (answered) return { state: 'answered', remainingMs: 0, label: '' }
  const remainingMs = Math.max(0, requestedAtMs + APPROVAL_TTL_MS - now)
  return remainingMs === 0
    ? { state: 'expired', remainingMs: 0, label: '0:00' }
    : { state: 'pending', remainingMs, label: formatCountdown(remainingMs) }
}

/** Approvals offer allow / reject only. "Always allow" style options are dropped. */
export function filterApprovalOptions<T extends { id?: string; label: string }>(options: T[]): T[] {
  const bad = /always|don.?t ask again|remember/i
  return options.filter((o) => !bad.test(o.label) && !bad.test(o.id ?? ''))
}

// ── Remote task state (pushed to renderer / mobile) ──────────────────

export type RemoteSyncState =
  | 'live'
  | 'runner-offline'
  | 'edited-on-web'
  | 'completed-on-spaces'
  | 'sync-paused'
  | 'connecting'

export interface RemoteBranchInfo {
  branch: string | null
  repository: string | null
  commitsAhead: number | null
  prUrl: string | null
  prNumber: number | null
  prState: string | null
  ciState: 'passing' | 'failing' | 'pending' | null
  files: Array<{ path: string; additions: number; deletions: number }>
}

export interface RemoteTaskState {
  taskId: string
  /** Spaces task id (server task). */
  serverTaskId: string | null
  /** Spaces coding-agent session id. */
  remoteSessionId: string | null
  runnerId: string | null
  runnerName: string | null
  harness: string | null
  sync: RemoteSyncState
  /** Unix ms of the last event from the server. */
  lastSyncedAt: number | null
  /** The server's status of the remote session. */
  sessionStatus: string | null
  /** Deep link to the task or chat in Spaces. */
  webUrl: string | null
  completedBy?: string | null
  completedAt?: number | null
  /** Someone else is typing / sent a message in Spaces. */
  editedOnWebBy?: string | null
  branch: RemoteBranchInfo | null
  /** Per-session credits/tokens line, e.g. "48k tokens · $0.61". */
  usageLine: string | null
}

export function remoteSyncLabel(state: RemoteSyncState): string {
  switch (state) {
    case 'live': return 'Synced'
    case 'runner-offline': return 'Runner offline'
    case 'edited-on-web': return 'Edited on web'
    case 'completed-on-spaces': return 'Completed on Spaces'
    case 'sync-paused': return 'Sync paused'
    case 'connecting': return 'Connecting…'
  }
}

/** Derives the sync state from session facts; the first matching rule wins. */
export function deriveRemoteSyncState(input: {
  signedIn: boolean
  serverTaskStatus?: string | null
  runnerOnline: boolean | null
  sessionActive: boolean
  connected: boolean
  editedOnWebAt?: number | null
  now?: number
}): RemoteSyncState {
  const now = input.now ?? Date.now()
  if (input.serverTaskStatus && ['completed', 'cancelled', 'expired'].includes(input.serverTaskStatus)) return 'completed-on-spaces'
  if (!input.signedIn) return 'sync-paused'
  if (input.runnerOnline === false && input.sessionActive) return 'runner-offline'
  if (input.editedOnWebAt && now - input.editedOnWebAt < 60_000) return 'edited-on-web'
  if (!input.connected) return 'connecting'
  return 'live'
}

// ── Spaces artifacts (read-only) ─────────────────────────────────────

export type SpacesArtifactKind = 'markdown' | 'html' | 'image' | 'file'

export interface SpacesArtifactSummary {
  /** `spaces:<sessionId>:<artifactId>` */
  id: string
  artifactId: string
  sessionId: string
  title: string
  kind: SpacesArtifactKind
  filename: string | null
  sizeBytes: number
  updatedAt: string | null
  webUrl: string | null
  /** Where the bytes came from this time. */
  availability: 'live' | 'cached' | 'not-cached'
  /** Always read-only. */
  readOnly: true
}

export type ArtifactSource = 'local' | 'spaces'

export function spacesArtifactId(sessionId: string, artifactId: string): string {
  return `spaces:${sessionId}:${artifactId}`
}

export function isSpacesArtifactId(id: string): boolean {
  return id.startsWith('spaces:')
}

/** Spaces artifacts can never be edited from 20x; local ones can. */
export function isArtifactEditable(source: ArtifactSource): boolean {
  return source === 'local'
}

export function artifactKindFromType(type: string | undefined, filename: string | null): SpacesArtifactKind {
  const t = (type ?? '').toLowerCase()
  if (t === 'markdown' || t === 'md') return 'markdown'
  if (t === 'html') return 'html'
  if (t === 'image') return 'image'
  const f = (filename ?? '').toLowerCase()
  if (f.endsWith('.md') || f.endsWith('.markdown')) return 'markdown'
  if (f.endsWith('.html') || f.endsWith('.htm')) return 'html'
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(f)) return 'image'
  return 'file'
}

/** Per-session credits/tokens line. */
export function formatRunnerUsageLine(usage: { tokens?: number; costUsd?: number; credits?: number } | null | undefined): string | null {
  if (!usage) return null
  const parts: string[] = []
  if (usage.tokens && usage.tokens > 0) parts.push(usage.tokens >= 1000 ? `${Math.round(usage.tokens / 1000)}k tokens` : `${usage.tokens} tokens`)
  if (usage.credits && usage.credits > 0) parts.push(`${usage.credits} credits`)
  else if (usage.costUsd && usage.costUsd > 0) parts.push(`$${usage.costUsd.toFixed(2)}`)
  return parts.length ? parts.join(' · ') : null
}

// ── IPC contract (`window.electronAPI.enterpriseRunners`) ────────────

export type RunnersResult =
  | { ok: true; runners: EnterpriseRunner[]; fetchedAt: number }
  | { ok: false; error: string; code: 'signed-out' | 'forbidden' | 'network' | 'unknown' }

/** What the agent form needs to know about a synced `[Workflo]` agent. */
export interface EnterpriseAgentRunnerInfo {
  agentId: string
  enterpriseAgentId: string | null
  /** Server backend: claude-code | codex | cursor | pi. */
  backend: string | null
  /** Server permission limit; the user may only narrow it. */
  permissionLimit: RunnerPermissionMode
  runnerPin: string | null
  /** False when the agent is not shared with the caller in Spaces. */
  usable: boolean
}

export interface TaskRunOn {
  choice: RunOnChoice
  /** True once a session has started: the choice is fixed. */
  locked: boolean
}

export type SpacesArtifactsStatus = 'ok' | 'empty' | 'offline' | 'loading' | 'error' | 'signed-out'

export interface SpacesArtifactsResult {
  status: SpacesArtifactsStatus
  artifacts: SpacesArtifactSummary[]
  /** Unix ms of the last successful fetch (also set when serving from cache). */
  syncedAt: number | null
  error?: string
}

export interface SpacesArtifactContent {
  availability: 'live' | 'cached' | 'not-cached'
  encoding: 'utf8' | 'base64' | 'none'
  mimeType: string
  content: string | null
  sizeBytes: number
  webUrl: string | null
}

export interface OpenLocallyResult {
  ok: boolean
  /** Local worktree path the branch was fetched into. */
  worktreePath?: string
  error?: string
}

/** Pushed on `enterprise-runner:state` (renderer) and the mobile WebSocket. */
export interface RemoteTaskStateEvent {
  taskId: string
  state: RemoteTaskState
}

export interface EnterpriseRunnersApi {
  listRunners: () => Promise<RunnersResult>
  getAgentInfo: (agentId: string) => Promise<EnterpriseAgentRunnerInfo>
  getTaskRunOn: (taskId: string) => Promise<TaskRunOn>
  /** Rejects with "locked" once a session has started. */
  setTaskRunOn: (taskId: string, choice: RunOnChoice) => Promise<TaskRunOn>
  getTaskState: (taskId: string) => Promise<RemoteTaskState | null>
  /** Context handoff / restart on another runner. Offered when the runner is offline. */
  reassign: (taskId: string, runnerId: string) => Promise<{ ok: boolean; error?: string }>
  openLocally: (taskId: string) => Promise<OpenLocallyResult>
  listSpacesArtifacts: (taskId: string, opts?: { refresh?: boolean }) => Promise<SpacesArtifactsResult>
  readSpacesArtifact: (taskId: string, id: string) => Promise<SpacesArtifactContent>
  onTaskState: (callback: (event: RemoteTaskStateEvent) => void) => () => void
}
