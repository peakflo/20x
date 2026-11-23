import { describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { serverTaskFields, serverTaskSnapshot, saveServerTaskSnapshot } from '../workflo-task-sync'
import { TaskStatus } from '../../shared/constants'
import { EnterpriseRunnerService, isSafeBranchName, sessionRecordKey, spacesWebUrl, type EnterpriseRunnerServiceDeps } from './service'
import { RunnerHttpError, type RunnerApi, type WireArtifact } from './runner-api'
import type { RemoteTaskStateEvent } from '../../shared/enterprise-runners'

function deps(over: Partial<EnterpriseRunnerServiceDeps> = {}) {
  const data = new Map<string, string>()
  const events: RemoteTaskStateEvent[] = []
  const tasks = new Map([['t1', { id: 't1', title: 'T', session_id: null as string | null, external_id: 'srv-1', agent_id: 'a1', repos: [] as string[] }]])
  const api = {
    listRunners: vi.fn(async () => []), listAgents: vi.fn(async () => []), listArtifacts: vi.fn(async (): Promise<WireArtifact[]> => [])
  } as unknown as RunnerApi
  const d: EnterpriseRunnerServiceDeps = {
    api,
    store: { get: (k) => data.get(k), set: (k, v) => void data.set(k, v), delete: (k) => void data.delete(k) },
    getTask: (id) => tasks.get(id),
    getAgent: () => ({ id: 'a1', config: { enterprise_agent_id: 'srv-agent', runner_id: 'r-pin' } }),
    getServerTaskStatus: () => null,
    isSignedIn: () => true,
    getApiUrl: () => 'https://api.peakflo.ai',
    currentUserId: () => 'me',
    getRepoDir: () => null,
    restartOnRunner: vi.fn(async () => undefined),
    emitState: (e) => void events.push(e),
    ...over
  }
  return { d, data, events, tasks, api }
}

const snap = (over: Record<string, unknown> = {}) => ({
  taskId: 't1', remoteSessionId: 's1', serverTaskId: 'srv-1', runnerId: 'r1', connected: true,
  session: { id: 's1', status: 'running', runnerId: 'r1' }, rev: 3, lastEventAt: 5000, lastForeignMessageAt: null,
  usage: { tokens: 48000, costUsd: 0.61, credits: 0 }, ...over
}) as never

describe('Run on: choice and lock', () => {
  it('stores the choice and locks it once a session has started', () => {
    const { d, data } = deps()
    const svc = new EnterpriseRunnerService(d)
    expect(svc.getTaskRunOn('t1')).toEqual({ choice: { kind: 'local' }, locked: false })
    svc.setTaskRunOn('t1', { kind: 'runner', runnerId: 'r1', runnerName: 'studio-mac' })
    expect(svc.getTaskRunOn('t1').choice).toMatchObject({ runnerId: 'r1' })
    data.set(sessionRecordKey('t1'), JSON.stringify({ remoteSessionId: 's1' }))
    expect(svc.getTaskRunOn('t1').locked).toBe(true)
    expect(() => svc.setTaskRunOn('t1', { kind: 'local' })).toThrow(/locked/i)
  })

  it('locks when the task already has a local session id', () => {
    const { d, tasks } = deps()
    tasks.get('t1')!.session_id = 'x'
    expect(new EnterpriseRunnerService(d).getTaskRunOn('t1').locked).toBe(true)
  })

  it('uses the picker choice for a session, falling back to the agent pin', () => {
    const { d } = deps()
    const svc = new EnterpriseRunnerService(d)
    expect(svc.runnerForSession('t1', 'a1')).toBe('r-pin')
    svc.setTaskRunOn('t1', { kind: 'runner', runnerId: 'r2', runnerName: 'x' })
    expect(svc.runnerForSession('t1', 'a1')).toBe('r2')
  })

  it('reassign restarts on the new runner and unlocks; an unavailable runner is refused', async () => {
    const { d, data, api } = deps()
    ;(api.listRunners as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'r2', name: 'build-box', selectable: true, personal: true, capabilities: { backends: [{ name: 'claude-code' }] } },
      { id: 'r3', name: 'old-laptop', selectable: false, unselectableReason: 'offline', unselectableLabel: 'not beating — last heartbeat 3h ago' }
    ])
    const svc = new EnterpriseRunnerService(d)
    data.set(sessionRecordKey('t1'), JSON.stringify({ remoteSessionId: 's1' }))
    expect(await svc.reassign('t1', 'r3')).toMatchObject({ ok: false })
    expect(d.restartOnRunner).not.toHaveBeenCalled()
    expect(await svc.reassign('t1', 'r2')).toEqual({ ok: true })
    expect(d.restartOnRunner).toHaveBeenCalledWith('t1')
    expect(JSON.parse(data.get('enterprise-runner:runon:t1')!)).toMatchObject({ runnerId: 'r2', runnerName: 'build-box' })
  })
})

describe('remote task state', () => {
  it('is null for a local task and live for a connected session', () => {
    const { d, events } = deps()
    const svc = new EnterpriseRunnerService(d)
    expect(svc.getTaskState('t1')).toBeNull()
    svc.onSnapshot(snap())
    expect(events[0].state).toMatchObject({ sync: 'live', remoteSessionId: 's1', usageLine: '48k tokens · $0.61' })
    expect(events[0].state.webUrl).toBe('https://app.peakflo.ai/coding-agents/s1')
  })

  it('shows runner offline when the stream is down during an active turn', () => {
    const { d } = deps()
    const svc = new EnterpriseRunnerService(d)
    svc.onSnapshot(snap({ connected: false }))
    expect(svc.getTaskState('t1')!.sync).toBe('runner-offline')
  })

  it('shows edited-on-web after a message from another participant', () => {
    const { d } = deps({ now: () => 10_000 })
    const svc = new EnterpriseRunnerService(d)
    svc.onSnapshot(snap({ lastForeignMessageAt: 9_000 }))
    expect(svc.getTaskState('t1')!.sync).toBe('edited-on-web')
  })

  it('pauses sync when signed out', () => {
    let signedIn = true
    const { d } = deps({ isSignedIn: () => signedIn })
    const svc = new EnterpriseRunnerService(d)
    svc.onSnapshot(snap())
    signedIn = false
    expect(svc.getTaskState('t1')!.sync).toBe('sync-paused')
  })

  it('shows "Completed on Spaces" when the server task is completed', () => {
    const { d } = deps({ getServerTaskStatus: () => 'completed' })
    const svc = new EnterpriseRunnerService(d)
    svc.onSnapshot(snap({ session: { id: 's1', status: 'idle', runnerId: 'r1' } }))
    expect(svc.getTaskState('t1')!.sync).toBe('completed-on-spaces')
  })
})

describe('sync: the server owns completion', () => {
  it('moves the 20x task to completed from the server snapshot, and a local completion is refused', () => {
    const { db } = createTestDb()
    const source = db.createTaskSource({ mcp_server_id: null, name: 'Workflo', plugin_id: 'peakflo' })!
    const task = db.createTask({ title: 'On a runner', source_id: source.id, external_id: 'srv-1' })!
    saveServerTaskSnapshot(db, task.id, { id: 'srv-1', status: 'in_progress' } as never)

    // A local completion call (what a runner session finishing must never do) is refused.
    expect(() => db.updateTask(task.id, { status: TaskStatus.Completed })).toThrow()
    expect(db.getTask(task.id)!.status).not.toBe(TaskStatus.Completed)

    // The server completes the task on Spaces; sync applies it with the server origin.
    const remote = { id: 'srv-1', status: 'completed' } as never
    saveServerTaskSnapshot(db, task.id, remote)
    db.updateTask(task.id, serverTaskFields(db, remote), 'workflo-server')
    expect(db.getTask(task.id)!.status).toBe(TaskStatus.Completed)
    expect(serverTaskSnapshot(db, task.id)!.status).toBe('completed')

    // The runner state then reads "Completed on Spaces" and never offers a local completion.
    const { d } = deps({ getServerTaskStatus: () => serverTaskSnapshot(db, task.id)?.status ?? null })
    const svc = new EnterpriseRunnerService(d)
    svc.onSnapshot(snap())
    expect(svc.getTaskState('t1')!.sync).toBe('completed-on-spaces')
  })
})

describe('Spaces artifacts: cache, offline and read-only', () => {
  const artifact = (id: string, content: string): WireArtifact => ({
    artifactId: id, title: `${id}.md`, type: 'markdown', previewFilename: `${id}.md`, fileCount: 1, totalBytes: content.length,
    createdAt: null, updatedAt: '2026-11-23T10:00:00Z', files: [{ filename: `${id}.md`, encoding: 'utf8', sizeBytes: content.length, updatedAt: null, content }]
  })

  it('lists live, then serves the cache when offline, and marks everything read-only', async () => {
    const { d, api } = deps()
    const svc = new EnterpriseRunnerService(d)
    svc.onSnapshot(snap())
    ;(api.listArtifacts as ReturnType<typeof vi.fn>).mockResolvedValueOnce([artifact('root-cause', '## Root cause')])
    const live = await svc.listSpacesArtifacts('t1')
    expect(live.status).toBe('ok')
    expect(live.artifacts[0]).toMatchObject({ readOnly: true, kind: 'markdown', availability: 'live', title: 'root-cause.md' })

    ;(api.listArtifacts as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new RunnerHttpError('fetch failed', null, 'network'))
    const offline = await svc.listSpacesArtifacts('t1')
    expect(offline.status).toBe('offline')
    expect(offline.artifacts[0]).toMatchObject({ readOnly: true, availability: 'cached' })
    expect(await svc.readSpacesArtifact('t1', offline.artifacts[0].id)).toMatchObject({ availability: 'cached', content: '## Root cause' })
  })

  it('reports empty and signed-out states', async () => {
    const { d } = deps()
    const svc = new EnterpriseRunnerService(d)
    svc.onSnapshot(snap())
    expect((await svc.listSpacesArtifacts('t1')).status).toBe('empty')
    const signedOut = new EnterpriseRunnerService(deps({ isSignedIn: () => false }).d)
    expect((await signedOut.listSpacesArtifacts('t1')).status).toBe('signed-out')
  })

  it('does not cache an artifact that contains a credential', async () => {
    const { d, api } = deps()
    const svc = new EnterpriseRunnerService(d)
    svc.onSnapshot(snap())
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk'
    ;(api.listArtifacts as ReturnType<typeof vi.fn>).mockResolvedValueOnce([artifact('leak', `token ${jwt}`)])
    const listed = await svc.listSpacesArtifacts('t1')
    expect((await svc.readSpacesArtifact('t1', listed.artifacts[0].id)).content).toBeNull()
  })
})

describe('Open locally (fetch branch)', () => {
  it('rejects unsafe branch names so they can never be read as git options', () => {
    expect(isSafeBranchName('fix/invoice-sync-race')).toBe(true)
    for (const bad of ['--upload-pack=evil', '-x', 'a..b', 'a b', 'x;rm', '', 'a.lock']) expect(isSafeBranchName(bad)).toBe(false)
  })

  it('fails clearly when the runner has published no branch', async () => {
    const { d } = deps()
    const svc = new EnterpriseRunnerService(d)
    svc.onSnapshot(snap())
    expect(await svc.openLocally('t1')).toMatchObject({ ok: false, error: expect.stringMatching(/branch/i) })
  })
})

describe('spacesWebUrl', () => {
  it('maps the api host to the app host', () => {
    expect(spacesWebUrl('https://api.peakflo.ai', '/tasks/1')).toBe('https://app.peakflo.ai/tasks/1')
  })
})
