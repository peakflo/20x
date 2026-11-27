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
  normaliseRunners,
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
import { RunnerHttpError, type RunnerApi, type WireArtifact } from './api-client'
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
  /**
   * Local clone directory for the repository the runner worked in (`owner/name`),
   * and whether it exists. Null when the task has no such repository.
   */
  getRepoDir(taskId: string, repository: string | null): { dir: string; exists: boolean; repository: string } | null
  /** Test seam for git. */
  git?(args: string[], cwd: string | undefined): Promise<void>
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** IPC input is untrusted: only a known shape with a bounded name is stored. */
export function validateRunOnChoice(input: unknown): RunOnChoice {
  const o = input as { kind?: unknown; runnerId?: unknown; runnerName?: unknown } | null
  if (o?.kind === 'local') return RUN_ON_LOCAL
  if (o?.kind === 'runner' && typeof o.runnerId === 'string' && UUID.test(o.runnerId)) {
    const name = typeof o.runnerName === 'string' ? o.runnerName.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) : ''
    return { kind: 'runner', runnerId: o.runnerId, runnerName: name || o.runnerId }
  }
  throw new Error('Invalid "Run on" choice.')
}

const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
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
      const raw = await this.deps.api.listRunnersRaw()
      return { ok: true, runners: normaliseRunners(raw, this.now()), fetchedAt: this.now() }
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
      usable,
      runnerOnly: cfg.coding_agent === ENTERPRISE_RUNNER_AGENT_TYPE
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
    const locked = this.sessionStarted(taskId)
    const task = this.deps.getTask(taskId)
    const runnerOnly = !!task?.agent_id && this.deps.getAgent(task.agent_id)?.config?.coding_agent === ENTERPRISE_RUNNER_AGENT_TYPE
    // Report where the session really runs, so the locked chip never names a
    // different place than the one the task is running on.
    const record = this.deps.store.get(sessionRecordKey(taskId))
    if (locked && record) {
      try {
        const r = JSON.parse(record) as { runnerId?: string | null }
        const rid = r.runnerId ?? (choice.kind === 'runner' ? choice.runnerId : null)
        if (rid) choice = { kind: 'runner', runnerId: rid, runnerName: choice.kind === 'runner' && choice.runnerId === rid ? choice.runnerName : rid }
      } catch { /* keep the stored choice */ }
    } else if (locked) {
      choice = RUN_ON_LOCAL
    }
    return { choice, locked, runnerOnly }
  }

  setTaskRunOn(taskId: string, input: unknown): TaskRunOn {
    if (this.sessionStarted(taskId)) throw new Error('The runner is locked: a session has already started on it.')
    const choice = validateRunOnChoice(input)
    const task = this.deps.getTask(taskId)
    const agent = task?.agent_id ? this.deps.getAgent(task.agent_id) : undefined
    if (choice.kind === 'local' && agent?.config?.coding_agent === ENTERPRISE_RUNNER_AGENT_TYPE) {
      throw new Error('This agent runs on a runner only.')
    }
    if (choice.kind === 'runner' && !agent?.config?.enterprise_agent_id) {
      throw new Error('This agent is not synced from Spaces, so it cannot run on a runner.')
    }
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
      if (typeof runnerId !== 'string' || !UUID.test(runnerId)) return { ok: false, error: 'Invalid runner.' }
      const runners = await this.listRunners()
      // The live session is only ended once the target is verified selectable.
      if (!runners.ok) return { ok: false, error: `Could not verify the runner: ${runners.error}` }
      const target = runners.runners.find((r) => r.id === runnerId)
      if (!target) return { ok: false, error: 'That runner is not available to you.' }
      if (!target.selectable) return { ok: false, error: target.serverReason ?? 'That runner is unavailable.' }
      // Restart on the new runner: the transcript stays on Spaces; the next
      // message starts a fresh session on the chosen runner.
      await this.deps.restartOnRunner(taskId)
      this.deps.store.set(runOnKey(taskId), JSON.stringify({ kind: 'runner', runnerId, runnerName: target.name }))
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
          key: summary.id, taskId, meta: summary, content: file && typeof text === 'string' ? text : null,
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
    // Nothing usable cached (never fetched, too large to cache, or looked
    // secret): read it live so an image or a fresh artifact still displays.
    const [, sessionId, artifactId] = /^spaces:([^:]+):(.+)$/.exec(id) ?? []
    if (sessionId && artifactId && this.deps.isSignedIn()) {
      try {
        const art = (await this.deps.api.listArtifacts(sessionId)).find((a) => a.artifactId === artifactId)
        const file = art?.files.find((f) => f.filename === art.previewFilename) ?? art?.files[0]
        if (art && file && typeof file.content === 'string') {
          const summary = this.toSummary(sessionId, art, 'live')
          return { availability: 'live', encoding: file.encoding === 'base64' ? 'base64' : 'utf8', mimeType: mimeFor(summary.kind, summary.filename), content: file.content, sizeBytes: art.totalBytes, webUrl: summary.webUrl }
        }
      } catch { /* offline: fall through to not-cached */ }
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
   * Fetch only. The runner's branch is fetched into the task's local clone as
   * `refs/remotes/origin/<branch>` and a namespaced `spaces/<branch>` ref is
   * created when it does not exist. No checkout, no reset, and no existing
   * branch (for example `main`) is ever touched. The task stays on the runner.
   * With no local clone the caller is asked to confirm a clone first.
   */
  async openLocally(taskId: string, opts: { clone?: boolean } = {}): Promise<OpenLocallyResult> {
    const state = this.getTaskState(taskId)
    const branch = state?.branch?.branch
    if (!branch) return { ok: false, error: 'The runner has not published a branch yet.' }
    if (!isSafeBranchName(branch)) return { ok: false, error: 'The branch name is not safe to fetch.' }
    const repo = this.deps.getRepoDir(taskId, state?.branch?.repository ?? null)
    if (!repo) return { ok: false, error: 'The runner did not report which repository it worked in.' }
    if (!REPO_SLUG.test(repo.repository)) return { ok: false, error: 'The repository name is not safe to clone.' }
    const git = this.deps.git ?? ((args: string[], cwd: string | undefined) => execFileAsync('git', args, { cwd, timeout: 180_000 }).then(() => undefined))
    try {
      if (!repo.exists) {
        if (!opts.clone) return { ok: false, needsClone: true, repository: repo.repository, error: `There is no local clone of ${repo.repository}.` }
        await git(['clone', '--no-checkout', '--', `https://github.com/${repo.repository}.git`, repo.dir], undefined)
      }
      // Argument arrays and `--`: the branch name can never be read as an option.
      await git(['fetch', 'origin', '--', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], repo.dir)
      const ref = `spaces/${branch}`
      let created = false
      try {
        // Without -f this fails when the ref already exists; that ref is left alone.
        await git(['branch', '--no-track', '--', ref, `refs/remotes/origin/${branch}`], repo.dir)
        created = true
      } catch { /* already exists: keep the user's branch */ }
      return { ok: true, worktreePath: repo.dir, branchRef: created ? ref : `origin/${branch}` }
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

const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif' }

function mimeFor(kind: SpacesArtifactSummary['kind'], filename: string | null): string {
  if (kind === 'markdown') return 'text/markdown'
  if (kind === 'html') return 'text/html'
  if (kind === 'image') return IMAGE_MIME[(filename ?? '').split('.').pop()?.toLowerCase() ?? ''] ?? 'image/png'
  return 'application/octet-stream'
}
