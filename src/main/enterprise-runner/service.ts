/**
 * EnterpriseRunnerService — the main-process side of the runner UI.
 *
 * Owns: the runner list, per-task "Run on" choice, the remote task state that
 * is pushed to the renderer and mobile, Spaces artifacts (read-only, cached),
 * and "Open locally (fetch branch)". The adapter does the transport; this
 * service never completes a task (the server owns completion).
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import {
  artifactKindFromType,
  clampPermissionMode,
  deriveRemoteSyncState,
  ENTERPRISE_RUNNER_AGENT_TYPE,
  formatRunnerUsageLine,
  normalizePermissionMode,
  RUN_ON_LOCAL,
  spacesArtifactId,
  toEnterpriseRunner,
  type EnterpriseAgentRunnerInfo,
  type OpenLocallyResult,
  type RemoteBranchInfo,
  type RemoteTaskState,
  type RemoteTaskStateEvent,
  type RunnersResult,
  type RunOnChoice,
  type SpacesArtifactContent,
  type SpacesArtifactsResult,
  type SpacesArtifactSummary,
  type TaskRunOn
} from '../../shared/enterprise-runners'
import type { RunnerSyncSnapshot } from '../adapters/enterprise-runner-adapter'
import { RunnerHttpError, type RunnerApi, type WireArtifact } from './runner-api'
import { SpacesArtifactCache, type CachedArtifact } from './spaces-artifact-cache'

const execFileAsync = promisify(execFile)

/** Settings key helpers shared with agent-manager. */
export const runOnKey = (taskId: string): string => `enterprise-runner:runon:${taskId}`
export const sessionRecordKey = (taskId: string): string => `enterprise-runner:session:${taskId}`

export interface ServiceTask {
  id: string
  title: string
  session_id: string | null
  external_id: string | null
  agent_id: string | null
  repos: string[]
}

export interface ServiceAgent {
  id: string
  config: Record<string, unknown>
}

export interface EnterpriseRunnerServiceDeps {
  api: RunnerApi
  store: { get(key: string): string | undefined; set(key: string, value: string): void; delete(key: string): void }
  getTask(taskId: string): ServiceTask | undefined
  getAgent(agentId: string): ServiceAgent | undefined
  /** Status of the server snapshot of a task (e.g. `completed`), if synced. */
  getServerTaskStatus(taskId: string): string | null
  isSignedIn(): boolean
  getApiUrl(): string
  currentUserId(): string | null
  /** Where a local worktree for the task lives, or null when none is set up. */
  getRepoDir(taskId: string): string | null
  /** Ends the current remote session and clears the task's session id. */
  restartOnRunner(taskId: string): Promise<void>
  emitState(event: RemoteTaskStateEvent): void
  openExternal?(url: string): void
  cacheFile?: string
  now?: () => number
}

/** `api.peakflo.ai` → `app.peakflo.ai`. TODO(server): return `webUrl` on tasks and sessions. */
export function spacesWebUrl(apiUrl: string, path: string): string | null {
  try {
    const u = new URL(apiUrl)
    u.hostname = u.hostname.replace(/^api\./, 'app.')
    u.pathname = path
    u.search = ''
    return u.toString()
  } catch {
    return null
  }
}

const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/

export function isSafeBranchName(branch: string): boolean {
  return BRANCH_RE.test(branch) && !branch.startsWith('-') && !branch.includes('..') && !branch.endsWith('.lock')
}

export class EnterpriseRunnerService {
  private readonly cache = new SpacesArtifactCache()
  private readonly snapshots = new Map<string, RunnerSyncSnapshot>()
  private readonly states = new Map<string, RemoteTaskState>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => number

  constructor(private readonly deps: EnterpriseRunnerServiceDeps) {
    this.now = deps.now ?? Date.now
    this.loadCache()
  }

  // ── runners ────────────────────────────────────────────────────────

  async listRunners(): Promise<RunnersResult> {
    if (!this.deps.isSignedIn()) return { ok: false, error: 'Sign in to Peakflo Enterprise to use runners.', code: 'signed-out' }
    try {
      const raw = await this.deps.api.listRunners()
      return { ok: true, runners: raw.map((r) => toEnterpriseRunner(r, this.now())), fetchedAt: this.now() }
    } catch (error) {
      const kind = error instanceof RunnerHttpError ? error.kind : 'server'
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: kind === 'forbidden' ? 'forbidden' : kind === 'auth' ? 'signed-out' : kind === 'network' ? 'network' : 'unknown'
      }
    }
  }

  async getAgentInfo(agentId: string): Promise<EnterpriseAgentRunnerInfo> {
    const agent = this.deps.getAgent(agentId)
    const cfg = agent?.config ?? {}
    const enterpriseAgentId = typeof cfg.enterprise_agent_id === 'string' ? cfg.enterprise_agent_id : null
    let backend: string | null = typeof cfg.runner_backend === 'string' ? cfg.runner_backend : null
    let limit = normalizePermissionMode(typeof cfg.runner_permission_limit === 'string' ? cfg.runner_permission_limit : 'ask')
    let usable = !!enterpriseAgentId
    if (enterpriseAgentId && this.deps.isSignedIn()) {
      try {
        const row = (await this.deps.api.listAgents()).find((a) => a.agentId === enterpriseAgentId)
        if (row) {
          backend = row.backend
          limit = normalizePermissionMode(row.permissionMode)
        } else {
          usable = false // not shared with the caller in Spaces
        }
      } catch {
        // keep cached values
      }
    }
    return {
      agentId, enterpriseAgentId, backend, permissionLimit: limit,
      runnerPin: typeof cfg.runner_id === 'string' ? cfg.runner_id : null,
      usable
    }
  }

  /** The permission mode to run with: the user's choice, never above the server limit. */
  effectivePermissionMode(chosen: string | null | undefined, limit: string | null | undefined): 'ask' | 'accept-edits' | 'bypass' {
    return clampPermissionMode(chosen, limit)
  }

  // ── run on ─────────────────────────────────────────────────────────

  private sessionStarted(taskId: string): boolean {
    const task = this.deps.getTask(taskId)
    return !!(task?.session_id && task.session_id.length > 0) || !!this.deps.store.get(sessionRecordKey(taskId))
  }

  getTaskRunOn(taskId: string): TaskRunOn {
    const raw = this.deps.store.get(runOnKey(taskId))
    let choice: RunOnChoice = RUN_ON_LOCAL
    if (raw) {
      try { choice = JSON.parse(raw) as RunOnChoice } catch { choice = RUN_ON_LOCAL }
    }
    return { choice, locked: this.sessionStarted(taskId) }
  }

  setTaskRunOn(taskId: string, choice: RunOnChoice): TaskRunOn {
    if (this.sessionStarted(taskId)) throw new Error('The runner is locked: a session has already started on it.')
    if (choice.kind === 'runner' && !choice.runnerId) throw new Error('A runner id is required.')
    this.deps.store.set(runOnKey(taskId), JSON.stringify(choice))
    return this.getTaskRunOn(taskId)
  }

  /** The runner a new session should use: the "Run on" choice, else the agent pin. */
  runnerForSession(taskId: string, agentId: string): string | null {
    const { choice } = this.getTaskRunOn(taskId)
    if (choice.kind === 'runner') return choice.runnerId
    const pin = this.deps.getAgent(agentId)?.config?.runner_id
    return typeof pin === 'string' && pin ? pin : null
  }

  async reassign(taskId: string, runnerId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const runners = await this.listRunners()
      const target = runners.ok ? runners.runners.find((r) => r.id === runnerId) : undefined
      if (runners.ok && !target) return { ok: false, error: 'That runner is not available to you.' }
      if (target && !target.selectable) return { ok: false, error: target.serverReason ?? 'That runner is unavailable.' }
      // Restart on the new runner: the transcript stays on Spaces; the next
      // message starts a fresh session on the chosen runner.
      await this.deps.restartOnRunner(taskId)
      this.deps.store.set(runOnKey(taskId), JSON.stringify({ kind: 'runner', runnerId, runnerName: target?.name ?? runnerId }))
      this.states.delete(taskId)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // ── remote task state ──────────────────────────────────────────────

  /** Called by the adapter on every sync change. */
  onSnapshot(snapshot: RunnerSyncSnapshot): void {
    this.snapshots.set(snapshot.taskId, snapshot)
    const state = this.buildState(snapshot.taskId)
    if (state) this.deps.emitState({ taskId: snapshot.taskId, state })
  }

  /** Re-derives state after auth or server-task changes. */
  refresh(taskId: string): void {
    const state = this.buildState(taskId)
    if (state) this.deps.emitState({ taskId, state })
  }

  getTaskState(taskId: string): RemoteTaskState | null {
    return this.buildState(taskId)
  }

  private branchFrom(session: RunnerSyncSnapshot['session']): RemoteBranchInfo | null {
    const meta = session?.metadata as Record<string, unknown> | undefined
    // TODO(server): the session does not expose branch / PR info as a typed
    // field yet; read the metadata keys the harness records when present.
    const branch = typeof meta?.branch === 'string' ? meta.branch : null
    const pr = (meta?.pullRequest ?? meta?.pr) as { url?: string; number?: number; state?: string; ci?: string } | undefined
    const files = Array.isArray(meta?.changedFiles) ? (meta!.changedFiles as RemoteBranchInfo['files']) : []
    if (!branch && !pr) return null
    return {
      branch,
      repository: session?.repositories?.[0]?.fullName ?? null,
      commitsAhead: typeof meta?.commitsAhead === 'number' ? meta.commitsAhead : null,
      prUrl: pr?.url ?? null,
      prNumber: pr?.number ?? null,
      prState: pr?.state ?? null,
      ciState: pr?.ci === 'passing' || pr?.ci === 'failing' || pr?.ci === 'pending' ? pr.ci : null,
      files
    }
  }

  private buildState(taskId: string): RemoteTaskState | null {
    const task = this.deps.getTask(taskId)
    const snap = this.snapshots.get(taskId)
    const record = this.deps.store.get(sessionRecordKey(taskId))
    if (!snap && !record) return null
    let remoteId = snap?.remoteSessionId ?? null
    let runnerId = snap?.runnerId ?? null
    if (record) {
      try {
        const r = JSON.parse(record) as { remoteSessionId?: string | null; runnerId?: string | null }
        remoteId = remoteId ?? r.remoteSessionId ?? null
        runnerId = runnerId ?? r.runnerId ?? null
      } catch { /* ignore */ }
    }
    const runOn = this.getTaskRunOn(taskId).choice
    const runnerName = runOn.kind === 'runner' && (!runnerId || runOn.runnerId === runnerId) ? runOn.runnerName : null
    const serverStatus = this.deps.getServerTaskStatus(taskId)
    const active = ['queued', 'leased', 'running'].includes(snap?.session?.status ?? '')
    const serverTaskId = snap?.serverTaskId ?? task?.external_id ?? null
    const sync = deriveRemoteSyncState({
      signedIn: this.deps.isSignedIn(),
      serverTaskStatus: serverStatus,
      // The stream is the presence signal for a session that is not finished.
      runnerOnline: snap ? (snap.connected || !active ? true : false) : null,
      sessionActive: active,
      connected: snap?.connected ?? false,
      editedOnWebAt: snap?.lastForeignMessageAt ?? null,
      now: this.now()
    })
    const state: RemoteTaskState = {
      taskId, serverTaskId, remoteSessionId: remoteId, runnerId, runnerName,
      harness: null,
      sync,
      lastSyncedAt: snap?.lastEventAt ?? this.states.get(taskId)?.lastSyncedAt ?? null,
      sessionStatus: snap?.session?.status ?? null,
      webUrl: remoteId ? spacesWebUrl(this.deps.getApiUrl(), `/coding-agents/${remoteId}`) : serverTaskId ? spacesWebUrl(this.deps.getApiUrl(), `/tasks/${serverTaskId}`) : null,
      editedOnWebBy: snap?.lastForeignMessageAt ? 'a teammate' : null,
      branch: this.branchFrom(snap?.session ?? null),
      usageLine: formatRunnerUsageLine(snap ? { tokens: snap.usage.tokens, costUsd: snap.usage.costUsd, credits: snap.usage.credits } : null)
    }
    this.states.set(taskId, state)
    return state
  }

  // ── Spaces artifacts (read-only) ───────────────────────────────────

  private toSummary(sessionId: string, a: WireArtifact, availability: SpacesArtifactSummary['availability']): SpacesArtifactSummary {
    const entry = a.files.find((f) => f.filename === a.previewFilename) ?? a.files[0]
    return {
      id: spacesArtifactId(sessionId, a.artifactId),
      artifactId: a.artifactId,
      sessionId,
      title: a.title,
      kind: artifactKindFromType(a.type, entry?.filename ?? null),
      filename: entry?.filename ?? null,
      sizeBytes: a.totalBytes,
      updatedAt: a.updatedAt,
      webUrl: spacesWebUrl(this.deps.getApiUrl(), `/coding-agents/${sessionId}`),
      availability,
      readOnly: true
    }
  }

  async listSpacesArtifacts(taskId: string): Promise<SpacesArtifactsResult> {
    if (!this.deps.isSignedIn()) return { status: 'signed-out', artifacts: [], syncedAt: null }
    const sessionId = this.remoteSessionIdOf(taskId)
    if (!sessionId) return { status: 'empty', artifacts: [], syncedAt: null }
    try {
      const artifacts = await this.deps.api.listArtifacts(sessionId)
      const summaries = artifacts.map((a) => this.toSummary(sessionId, a, 'live'))
      for (const a of artifacts) {
        const summary = this.toSummary(sessionId, a, 'cached')
        const file = a.files.find((f) => f.filename === a.previewFilename) ?? a.files[0]
        const text = file?.content ?? null
        this.cache.put({
          key: summary.id, taskId, meta: summary, content: file && typeof text === 'string' && file.encoding !== 'base64' ? text : null,
          encoding: file && typeof text === 'string' ? (file.encoding === 'base64' ? 'base64' : 'utf8') : 'none',
          mimeType: mimeFor(summary.kind, summary.filename), sizeBytes: a.totalBytes
        })
      }
      this.scheduleSave()
      return { status: summaries.length ? 'ok' : 'empty', artifacts: summaries, syncedAt: this.now() }
    } catch (error) {
      const cached = this.cache.listForTask(taskId)
      if (cached.length > 0) {
        return {
          status: 'offline',
          artifacts: cached.map((c) => ({ ...(c.meta as SpacesArtifactSummary), availability: c.content !== null || c.encoding === 'none' && c.sizeBytes === 0 ? 'cached' : 'not-cached' })),
          syncedAt: Math.max(...cached.map((c) => c.storedAt))
        }
      }
      return { status: error instanceof RunnerHttpError && error.kind === 'network' ? 'offline' : 'error', artifacts: [], syncedAt: null, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async readSpacesArtifact(_taskId: string, id: string): Promise<SpacesArtifactContent> {
    const cached = this.cache.get(id)
    const url = (cached?.meta as SpacesArtifactSummary | undefined)?.webUrl ?? null
    if (cached && cached.content !== null) {
      return { availability: 'cached', encoding: cached.encoding, mimeType: cached.mimeType, content: cached.content, sizeBytes: cached.sizeBytes, webUrl: url }
    }
    return { availability: 'not-cached', encoding: 'none', mimeType: cached?.mimeType ?? 'application/octet-stream', content: null, sizeBytes: cached?.sizeBytes ?? 0, webUrl: url }
  }

  private remoteSessionIdOf(taskId: string): string | null {
    const snap = this.snapshots.get(taskId)
    if (snap?.remoteSessionId) return snap.remoteSessionId
    const record = this.deps.store.get(sessionRecordKey(taskId))
    if (!record) return null
    try { return (JSON.parse(record) as { remoteSessionId?: string | null }).remoteSessionId ?? null } catch { return null }
  }

  // ── Open locally (fetch branch) ────────────────────────────────────

  /**
   * Fetch only. The branch is fetched into the task's local worktree; the task
   * stays on the runner and Spaces still owns it.
   */
  async openLocally(taskId: string): Promise<OpenLocallyResult> {
    const state = this.getTaskState(taskId)
    const branch = state?.branch?.branch
    if (!branch) return { ok: false, error: 'The runner has not published a branch yet.' }
    if (!isSafeBranchName(branch)) return { ok: false, error: 'The branch name is not safe to fetch.' }
    const dir = this.deps.getRepoDir(taskId)
    if (!dir || !existsSync(dir)) return { ok: false, error: 'No local checkout of this repository. Add the repository to the task first.' }
    try {
      // Argument array + `--`: the branch name can never be read as an option.
      await execFileAsync('git', ['fetch', 'origin', '--', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: dir, timeout: 120_000 })
      await execFileAsync('git', ['checkout', '-B', branch, `refs/remotes/origin/${branch}`], { cwd: dir, timeout: 60_000 })
      return { ok: true, worktreePath: dir }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message.split('\n')[0] : String(error) }
    }
  }

  // ── cache persistence ──────────────────────────────────────────────

  private loadCache(): void {
    const file = this.deps.cacheFile
    if (!file || !existsSync(file)) return
    try { this.cache.restore(JSON.parse(readFileSync(file, 'utf8')) as CachedArtifact[]) } catch { /* corrupt cache: start empty */ }
  }

  private scheduleSave(): void {
    if (!this.deps.cacheFile || this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      try {
        mkdirSync(dirname(this.deps.cacheFile!), { recursive: true })
        writeFileSync(this.deps.cacheFile!, JSON.stringify(this.cache.snapshot()), { mode: 0o600 })
      } catch { /* best effort */ }
    }, 2000)
    this.saveTimer.unref?.()
  }

  dispose(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
  }
}

function mimeFor(kind: SpacesArtifactSummary['kind'], filename: string | null): string {
  if (kind === 'markdown') return 'text/markdown'
  if (kind === 'html') return 'text/html'
  if (kind === 'image') return filename?.endsWith('.svg') ? 'image/svg+xml' : 'image/*'
  return 'application/octet-stream'
}

export { ENTERPRISE_RUNNER_AGENT_TYPE }
