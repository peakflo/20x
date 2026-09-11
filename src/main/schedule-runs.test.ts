import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { AgentManager } from './agent-manager'
import { ScheduleRuns } from './schedule-runs'
import { RecurrenceScheduler } from './recurrence-scheduler'
import { TaskControl } from './task-control'
import type { ResponsibilityManager } from './responsibility-manager'
import { createRegisteredTaskArtifact, writeRegisteredTaskArtifactFile } from './artifacts'
import { ArtifactType } from '../shared/artifacts'
import type { ScheduleRun } from '../shared/schedule-runs'
import { startTaskApiServer, stopTaskApiServer, setTaskApiAgentController } from './task-api-server'

let db: ReturnType<typeof createTestDb>['db']
let agents: AgentManager
let runs: ScheduleRuns
let scheduler: RecurrenceScheduler
let root: string
let taskId: string
let agentId: string
let destroy: ReturnType<typeof vi.fn>
let launch: ReturnType<typeof vi.spyOn>
const emit = (channel: string, data: unknown) => (agents as unknown as { sendToRenderer(c: string, d: unknown): void }).sendToRenderer(channel, data)
const output = (sessionId: string, text: string) => emit('agent:output', { sessionId, taskId, data: { id: 'provider-part-1', role: 'assistant', content: text, partType: 'text' } })
const finish = (sessionId: string) => emit('agent:status', { sessionId, taskId, agentId, status: 'idle' })
const tick = () => (scheduler as unknown as { checkAndCreateDueInstances(): Promise<void> }).checkAndCreateDueInstances()

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), '20x-reuse-'))
  vi.mocked(app.getPath).mockReturnValue(root)
  ;({ db } = createTestDb())
  db.db.exec('ALTER TABLE tasks ADD COLUMN heartbeat_enabled INTEGER NOT NULL DEFAULT 0')
  vi.spyOn(db, 'getWorkspaceDir').mockImplementation(id => { const path = join(root, 'workspaces', id); mkdirSync(path, { recursive: true }); return path })
  agentId = db.createAgent({ name: 'Monitor agent' })!.id
  taskId = db.createTask({ title: 'Monitor source', is_recurring: true, recurrence_pattern: '*/5 * * * *', auto_start_agent: true })!.id
  db.updateTask(taskId, { agent_id: agentId })
  agents = new AgentManager(db)
  runs = new ScheduleRuns(db, agents, vi.fn())
  agents.setScheduleRuns(runs)
  scheduler = new RecurrenceScheduler(db, 'UTC', runs)
  destroy = vi.fn(async () => undefined)
  vi.spyOn(agents as unknown as { buildSessionConfig(): Promise<object> }, 'buildSessionConfig').mockResolvedValue({})
  let seq = 0
  launch = vi.spyOn(agents as unknown as { startTaskSession(a: string, t: string): Promise<string> }, 'startTaskSession').mockImplementation(async (a, t) => {
    const id = `session-${++seq}`
    const sessions = (agents as unknown as { sessions: Map<string, object> }).sessions
    sessions.set(id, { id, agentId: a, taskId: t, status: 'working', createdAt: new Date(), seenMessageIds: new Set(), seenPartIds: new Set(), partContentLengths: new Map(), adapter: { destroySession: destroy } })
    runs.bind(t, id)
    emit('agent:status', { taskId: t, agentId: a, sessionId: id, status: 'working' })
    return id
  })
})
afterEach(async () => {
  await runs.stop()
  await agents.stopAllSessions()
  db.db.close()
  vi.restoreAllMocks()
  vi.mocked(app.getPath).mockReturnValue('/tmp/pf-desktop-test')
  rmSync(root, { recursive: true, force: true })
})

describe('Reusable scheduled checks', () => {
  it.skipIf(process.env.RUN_SCHEDULE_LIVE !== '1')('runs two native checks with fresh sessions and a persistent checkpoint', async () => {
    launch.mockRestore()
    vi.mocked((agents as unknown as { buildSessionConfig(): Promise<object> }).buildSessionConfig).mockRestore()
    db.updateAgent(agentId, { config: { coding_agent: 'codex', model: process.env.SCHEDULE_LIVE_MODEL || 'gpt-5.6-luna', reasoning_effort: 'medium', permission_mode: 'ask', sandbox_mode: 'workspace-write' } })
    db.updateTask(taskId, { description: 'Only in this temporary workspace: read checkpoint.txt if present, increment its integer by one (start at 1), and write it back followed by a newline. Reply with CHECK_NUMBER=<integer>. Do not inspect other folders, contact external sources, use other agents, or create other tasks. Then finish this one check.' })
    setTaskApiAgentController(agents)
    await startTaskApiServer(db)
    try {
      for (const number of [1, 2]) {
        db.updateTask(taskId, { next_occurrence_at: new Date(Date.now() - 1000).toISOString() })
        await tick()
        const deadline = Date.now() + 90000
        while (runs.active(taskId) && Date.now() < deadline) {
          if (runs.active(taskId)?.state === 'interrupted') throw new Error(runs.active(taskId)!.summary)
          await new Promise(resolve => setTimeout(resolve, 250))
          await runs.reconcile()
        }
        expect(runs.active(taskId)).toBeUndefined()
        expect(readFileSync(join(db.getWorkspaceDir(taskId), 'checkpoint.txt'), 'utf8')).toBe(`${number}\n`)
        expect(agents.findSessionByTaskId(taskId)).toBeUndefined()
      }
      const history = runs.history(taskId) as ScheduleRun[]
      expect(db.getTasks()).toHaveLength(1)
      expect(history).toHaveLength(2)
      expect(new Set(history.map(r => r.sessionId)).size).toBe(2)
      expect(history.every(r => r.state === 'finished' && r.summary.includes('CHECK_NUMBER='))).toBe(true)
      console.log('LIVE_SCHEDULE_RECEIPT', JSON.stringify(history.map(r => ({ id: r.id, sessionId: r.sessionId, state: r.state, summary: r.summary }))))
    } finally { await agents.stopAllSessions(); setTaskApiAgentController(null); await stopTaskApiServer() }
  }, 210000)

  it('defaults to one task and freezes separate transcripts and artifact versions for consecutive checks', async () => {
    expect(db.getTask(taskId)?.recurrence_mode).toBe('reuse')
    const workspace = db.getWorkspaceDir(taskId)
    const artifact = await createRegisteredTaskArtifact(workspace, taskId, { title: 'Result', type: ArtifactType.MARKDOWN })
    const first = await agents.startSession(agentId, taskId)
    const firstRun = runs.active(taskId)!.id
    output(first, 'First result')
    await writeRegisteredTaskArtifactFile(workspace, taskId, { artifactId: artifact.artifactId, filename: 'result.md', content: 'First report' })
    finish(first)
    await vi.waitFor(() => expect(runs.active(taskId)).toBeUndefined())
    const saved = runs.history(taskId, firstRun) as ScheduleRun & { transcript: { content: string }[] }
    expect(saved).toMatchObject({ state: 'finished', summary: 'First result' })
    expect(saved.transcript[0].content).toBe('First result')
    expect(readFileSync(saved.artifacts[0].path, 'utf8')).toBe('First report')
    const second = await agents.startSession(agentId, taskId)
    expect(second).not.toBe(first)
    expect(runs.context(taskId)).toContain('First result')
    output(second, 'Second result')
    output(first, 'Late stale output')
    await writeRegisteredTaskArtifactFile(workspace, taskId, { artifactId: artifact.artifactId, filename: 'result.md', content: 'Second report' })
    finish(second)
    await vi.waitFor(() => expect(runs.active(taskId)).toBeUndefined())
    expect(db.getTasks()).toHaveLength(1)
    expect(db.getWorkspaceDir(taskId)).toBe(workspace)
    expect(db.getTranscriptParts(taskId).map(p => p.content)).toEqual(['First result', 'Second result'])
    expect(readFileSync(saved.artifacts[0].path, 'utf8')).toBe('First report')
    expect(runs.history(taskId) as ScheduleRun[]).toHaveLength(2)
    expect(destroy).toHaveBeenCalledTimes(2)
    await expect(agents.resumeSession(agentId, taskId, first)).rejects.toThrow('historical')
    await expect(agents.sendMessage(first, 'Continue old run', taskId, agentId)).rejects.toThrow('Historical')
  })

  it('shares admission for timers and manual starts, including pending approval and runtime cleanup', async () => {
    db.updateTask(taskId, { next_occurrence_at: new Date(Date.now() - 60_000).toISOString() })
    await tick()
    const first = runs.active(taskId)!.sessionId!
    await expect(agents.startSession(agentId, taskId)).rejects.toThrow('already running')
    emit('agent:status', { sessionId: first, taskId, agentId, status: 'waiting_approval' })
    expect(runs.active(taskId)?.state).toBe('waiting_approval')
    db.updateTask(taskId, { next_occurrence_at: new Date(Date.now() - 60_000).toISOString() })
    await tick()
    expect(launch).toHaveBeenCalledTimes(1)
    let release!: () => void
    destroy.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    output(first, 'Done'); finish(first)
    await expect(agents.startSession(agentId, taskId)).rejects.toThrow('stopping this task')
    expect(() => runs.assertMessage(taskId, first)).toThrow('inspect')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    await vi.waitFor(() => expect(runs.active(taskId)).toBeUndefined())
    expect(db.getTasks()).toHaveLength(1)
  })

  it('waits for an in-flight permission answer before releasing a finished check', async () => {
    const id = await agents.startSession(agentId, taskId)
    Object.assign(agents.getSession(id)!.adapter!, { respondToQuestion: vi.fn() })
    let resolveConfig!: (value: object) => void
    vi.mocked((agents as unknown as { buildSessionConfig(): Promise<object> }).buildSessionConfig).mockImplementationOnce(() => new Promise(resolve => { resolveConfig = resolve }))
    const answer = expect(agents.respondToPermission(id, true, 'Answer', undefined, 'question')).rejects.toThrow('stopping this task')
    output(id, 'Result'); finish(id)
    expect(destroy).not.toHaveBeenCalled()
    resolveConfig({})
    await answer
    await vi.waitFor(() => expect(runs.active(taskId)).toBeUndefined())
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(db.getTask(taskId)?.auto_start_agent).toBe(true)
  })

  it('keeps run ownership when a provider replaces its temporary session ID', async () => {
    const temporary = await agents.startSession(agentId, taskId)
    const sessions = (agents as unknown as { sessions: Map<string, unknown> }).sessions
    sessions.set('provider-real-id', sessions.get(temporary)); sessions.delete(temporary)
    output('provider-real-id', 'Rekeyed result')
    finish('provider-real-id')
    await vi.waitFor(() => expect(runs.active(taskId)).toBeUndefined())
    expect((runs.history(taskId) as ScheduleRun[])[0]).toMatchObject({ sessionId: 'provider-real-id', state: 'finished', summary: 'Rekeyed result' })
    expect(destroy).toHaveBeenCalledWith('provider-real-id', { agentId, taskId, workspaceDir: process.cwd() })
    const next = await agents.startSession(agentId, taskId)
    const session = agents.getSession(next)!
    Object.assign(session.adapter!, { getAllMessages: async () => [{ role: 'assistant', parts: [{ id: 'finalized-part', type: 'text', content: 'Rekeyed result' }] }] })
    const replay = agents as unknown as { replayMissedTranscriptPartsBeforeIdle(id: string, owner: typeof session): Promise<number> }
    expect(await replay.replayMissedTranscriptPartsBeforeIdle(next, session)).toBe(1)
    finish(next)
    await vi.waitFor(() => expect(runs.active(taskId)).toBeUndefined())
    expect(db.getTranscriptParts(taskId).filter(p => p.content === 'Rekeyed result')).toHaveLength(2)
  })

  it('pauses and strictly releases a working check before completion or deletion', async () => {
    const id = await agents.startSession(agentId, taskId)
    output(id, 'Partial work')
    const complete = vi.fn(async () => {
      expect(agents.isTaskStoppedForControl(taskId)).toBe(true)
      expect(runs.active(taskId)).toBeUndefined()
      expect(db.getTask(taskId)?.recurrence_paused).toBe(true)
      return { success: false, error: 'Workflo unavailable' }
    })
    const responsibilities = { projectForTask: () => undefined, stepForTask: () => undefined, snapshot: () => ({ responsibilities: [] }) } as unknown as ResponsibilityManager
    const control = new TaskControl(db, agents, { completeTask: complete }, responsibilities, async () => true, vi.fn(), scheduler)
    destroy.mockRejectedValueOnce(new Error('Cleanup failed'))
    await expect(control.run({ task_id: taskId, action: 'complete' })).rejects.toThrow('Cleanup failed')
    expect(complete).not.toHaveBeenCalled()
    expect(await control.run({ task_id: taskId, action: 'complete' })).toMatchObject({ success: false, error: 'Workflo unavailable' })
    expect(db.getTask(taskId)).toMatchObject({ recurrence_paused: true, auto_start_agent: false })
    expect(db.getTranscriptParts(taskId)[0].content).toBe('Partial work')
    vi.spyOn(db, 'deleteTaskAttachments').mockImplementation(() => {})
    expect(await control.run({ task_id: taskId, action: 'delete' })).toMatchObject({ success: true })
    expect(db.getTask(taskId)).toBeUndefined()
    expect(db.db.prepare('SELECT * FROM task_schedule_runs').all()).toHaveLength(0)
    await control.stop()
  })

  it('coalesces manual checks and preserves paused state through mode conversion', async () => {
    db.updateTask(taskId, { auto_start_agent: false, next_occurrence_at: new Date(Date.now() - 60_000).toISOString() })
    await tick()
    const pending = runs.active(taskId)!.id
    db.updateTask(taskId, { next_occurrence_at: new Date(Date.now() - 60_000).toISOString() })
    await tick()
    expect(runs.active(taskId)!.id).toBe(pending)
    expect(launch).not.toHaveBeenCalled()
    expect(() => scheduler.setMode(taskId, 'separate')).toThrow('Pause')
    scheduler.setPaused(taskId, true)
    const sessions = (agents as unknown as { sessions: Map<string, object> }).sessions
    sessions.set('old-idle-runtime', { id: 'old-idle-runtime', taskId, status: 'idle' })
    expect(() => scheduler.setMode(taskId, 'separate')).toThrow('existing instance sessions')
    expect(runs.active(taskId)?.id).toBe(pending)
    sessions.delete('old-idle-runtime')
    expect(scheduler.setMode(taskId, 'separate')).toMatchObject({ recurrence_mode: 'separate', recurrence_paused: true })
    expect(runs.active(taskId)).toBeUndefined()
    expect((runs.history(taskId) as ScheduleRun[])[0].finishedAt).toBeTruthy()
  })

  it('blocks failed cleanup and interrupted restart until inspected recovery', async () => {
    const id = await agents.startSession(agentId, taskId)
    output(id, 'Partial result')
    destroy.mockRejectedValueOnce(new Error('Process release unknown'))
    finish(id)
    await vi.waitFor(() => expect(runs.active(taskId)?.state).toBe('interrupted'))
    expect(db.getTask(taskId)?.recurrence_paused).toBe(true)
    expect(() => scheduler.setPaused(taskId, false)).toThrow('interrupted')
    await expect(agents.startSession(agentId, taskId)).rejects.toThrow('inspection')
    finish(id)
    await Promise.resolve()
    expect(destroy).toHaveBeenCalledTimes(1)
    await expect(agents.respondToPermission(id, true)).rejects.toThrow('inspect')
    await runs.recover(taskId)
    expect(runs.active(taskId)).toBeUndefined()
    expect(db.getTask(taskId)).toMatchObject({ recurrence_paused: true, auto_start_agent: true })
    scheduler.setPaused(taskId, false)
    const next = await agents.startSession(agentId, taskId)
    await agents.stopSession(next, false, true)
    runs = new ScheduleRuns(db, agents, vi.fn()); agents.setScheduleRuns(runs)
    expect(runs.active(taskId)?.state).toBe('interrupted')
    expect(db.getTask(taskId)?.recurrence_paused).toBe(true)
  })

  it('retains an uncertain launch for inspection and stops admitting checks on quit', async () => {
    launch.mockRejectedValueOnce(new Error('Provider launch failed'))
    await expect(agents.startSession(agentId, taskId)).rejects.toThrow('Provider launch failed')
    expect(runs.active(taskId)).toMatchObject({ state: 'interrupted', finishedAt: null })
    await runs.recover(taskId)
    await runs.stop()
    await expect(agents.startSession(agentId, taskId)).rejects.toThrow('quitting')
  })
})
