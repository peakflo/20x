/**
 * Wires the runner service and adapter factory to the app (database, enterprise
 * auth, task sync). Created once in main/index.ts and handed to agent-manager
 * and the IPC layer.
 */

import { existsSync } from 'fs'
import { join } from 'path'
import type { DatabaseManager } from '../database'
import type { EnterpriseAuth } from '../enterprise-auth'
import type { SyncManager } from '../sync-manager'
import { EnterpriseRunnerAdapter, type EnterpriseRunnerHost } from '../adapters/enterprise-runner-adapter'
import { HttpRunnerApi, type RunnerApi } from './runner-api'
import { EnterpriseRunnerService } from './service'
import type { RemoteTaskStateEvent } from '../../shared/enterprise-runners'
import { serverTaskSnapshot } from '../workflo-task-sync'

export interface EnterpriseRunnerRuntime {
  api: RunnerApi
  service: EnterpriseRunnerService
  createAdapter(): EnterpriseRunnerAdapter
  /** Makes sure the 20x task exists on Spaces. Used before a runner session starts. */
  ensureServerTask(taskId: string): Promise<string>
}

export interface RuntimeDeps {
  db: DatabaseManager
  auth: EnterpriseAuth
  getSyncManager: () => SyncManager | undefined
  emitState: (event: RemoteTaskStateEvent) => void
  /** Ends the live session of a task (agent-manager). */
  endTaskSession: (taskId: string) => Promise<void>
  openExternal?: (url: string) => void
  userDataDir: string
  api?: RunnerApi
}

const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export function createEnterpriseRunnerRuntime(deps: RuntimeDeps): EnterpriseRunnerRuntime {
  const { db, auth } = deps
  const api = deps.api ?? new HttpRunnerApi(auth)
  const store = {
    get: (key: string) => db.getSetting(key),
    set: (key: string, value: string) => db.setSetting(key, value),
    delete: (key: string) => db.deleteSetting(key)
  }

  const isSignedIn = (): boolean => !!db.getSetting('enterprise_tenant_id') && !!db.getSetting('enterprise_user_id')

  const ensureServerTask = async (taskId: string): Promise<string> => {
    const existing = db.getTask(taskId)
    if (!existing) throw new Error('Task not found.')
    if (existing.external_id) return existing.external_id
    const sync = deps.getSyncManager()
    if (!sync) throw new Error('Sign in to Peakflo Enterprise to run on a runner.')
    await sync.uploadTask(taskId)
    await sync.flushTaskUploads()
    const synced = db.getTask(taskId)
    if (!synced?.external_id) throw new Error('The task could not be synced to Spaces yet. Check your connection and try again.')
    return synced.external_id
  }

  const service: EnterpriseRunnerService = new EnterpriseRunnerService({
    api,
    store,
    getTask: (id) => {
      const t = db.getTask(id)
      return t ? { id: t.id, title: t.title, session_id: t.session_id ?? null, external_id: t.external_id ?? null, agent_id: t.agent_id ?? null, repos: t.repos ?? [] } : undefined
    },
    getAgent: (id) => {
      const a = db.getAgent(id)
      return a ? { id: a.id, config: (a.config ?? {}) as Record<string, unknown> } : undefined
    },
    getServerTaskStatus: (id) => serverTaskSnapshot(db, id)?.status ?? null,
    isSignedIn,
    getApiUrl: () => auth.getApiUrl(),
    currentUserId: () => db.getSetting('enterprise_user_id') ?? null,
    getRepoDir: (id, repository) => {
      const repos = (db.getTask(id)?.repos ?? []).filter((r) => REPO_SLUG.test(r))
      const full = (repository && REPO_SLUG.test(repository) ? repos.find((r) => r.toLowerCase() === repository.toLowerCase()) ?? repository : repos[0]) ?? null
      if (!full) return null
      const dir = join(db.getWorkspaceDir(id), full.split('/')[1])
      return { dir, exists: existsSync(join(dir, '.git')), repository: full }
    },
    restartOnRunner: async (taskId) => {
      await deps.endTaskSession(taskId)
      store.delete(`enterprise-runner:session:${taskId}`)
      db.updateTask(taskId, { session_id: null })
    },
    emitState: deps.emitState,
    openExternal: deps.openExternal,
    cacheFile: join(deps.userDataDir, 'spaces-artifact-cache.json')
  })

  const host: EnterpriseRunnerHost = {
    api,
    store,
    ensureServerTask,
    getEnterpriseAgentId: (agentId) => {
      const id = (db.getAgent(agentId)?.config as Record<string, unknown> | undefined)?.enterprise_agent_id
      return typeof id === 'string' && id ? id : null
    },
    getRunnerId: (taskId, agentId) => service.runnerForSession(taskId, agentId),
    getTaskInfo: (taskId) => {
      const t = db.getTask(taskId)
      return t ? { title: t.title, repositories: (t.repos ?? []).filter((r) => REPO_SLUG.test(r)) } : null
    },
    currentUserId: () => db.getSetting('enterprise_user_id') ?? null,
    isSignedIn: () => isSignedIn(),
    // Every local secret value goes into the request guard, once per runtime
    // (the guard only grows), not just the ones the current agent uses.
    localSecretValues: () => {
      try { return db.getSecretsWithValues(db.getSecrets().map((x) => x.id)).map((x) => x.value).filter((v) => typeof v === 'string' && v.length >= 6) } catch { return [] }
    },
    onSnapshot: (snapshot) => service.onSnapshot(snapshot)
  }

  return {
    api,
    service,
    ensureServerTask,
    createAdapter: () => new EnterpriseRunnerAdapter(host)
  }
}
