import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { ResponsibilityManager, captureWork, collectSource } from './responsibility-manager'
import { projectConversationId } from '../shared/responsibilities'
import type { ResponsibilityAgreement, ResponsibilityStep, WorkEvidence } from '../shared/responsibilities'
import type { AgentManager } from './agent-manager'
import { callResponsibilityTool } from './responsibility-tools'
import { TaskControl } from './task-control'
import { RoutineSources } from './routine-sources'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { startTaskApiServer, stopTaskApiServer, setTaskControl, setResponsibilityManager } from './task-api-server'

let dir: string
let manager: ResponsibilityManager
let db: ReturnType<typeof createTestDb>['db']
let project: ReturnType<ResponsibilityManager['createProject']>
let sessions: Map<string, { sessionId: string; session: { workspaceDir: string; status: string } }>
let runtime: Pick<AgentManager, 'startSession' | 'stopSession' | 'findSessionByTaskId' | 'getSessionStatus' | 'respondToPermission' | 'sendByTaskId'>
let collect: ReturnType<typeof vi.fn<typeof collectSource>>
let inspect: ReturnType<typeof vi.fn<typeof captureWork>>
let agreement: ResponsibilityAgreement
const evidence = (): WorkEvidence => ({ checkout: dir, revision: 'abc123', fingerprint: 'original-files' })
const snapshot = () => manager.snapshot(project.id)
const scope = () => manager.scopeForToken(manager.tokenForTask(projectConversationId(project.id))!)
const input = (value = 'Fix the bug, prove it, and stop before merge') => manager.recordHumanInput(projectConversationId(project.id), value)!.id

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), '20x-responsibility-'))
  ;({ db } = createTestDb())
  db.getWorkspaceDir = vi.fn(taskId => { const p = join(dir, '.sessions', taskId); mkdirSync(p, { recursive: true }); return p })
  const agent = db.createAgent({ name: 'Engineer', config: { coding_agent: 'codex', model: 'chosen-model', reasoning_effort: 'medium' } })!
  sessions = new Map()
  runtime = {
    startSession: vi.fn(async (_agent, taskId, cwd) => { const live = { sessionId: `session-${taskId}`, session: { workspaceDir: cwd ?? dir, status: 'working' } }; sessions.set(taskId, live); return live.sessionId }),
    stopSession: vi.fn(async id => { for (const [task, live] of sessions) if (live.sessionId === id) sessions.delete(task) }),
    findSessionByTaskId: vi.fn(taskId => sessions.get(taskId)) as unknown as AgentManager['findSessionByTaskId'],
    getSessionStatus: vi.fn(id => { for (const [taskId, live] of sessions) if (live.sessionId === id) return { status: live.session.status, taskId, agentId: agent.id }; return null }),
    respondToPermission: vi.fn(async () => {}),
    sendByTaskId: vi.fn(async () => ({ sessionId: 'shared-session' }))
  }
  collect = vi.fn(async () => '{"release":"green"}')
  inspect = vi.fn(async () => evidence())
  manager = new ResponsibilityManager(db, runtime, vi.fn(), collect, inspect)
  project = manager.createProject('Example', dir, agent.id)
  agreement = { kind: 'goal', title: 'Fix regression', objective: 'Fix and verify the regression', scope: 'This project only; stop before merge', finish: 'Reproduction passes on the actual revision', stop: 'Ask before production changes', mode: 'edit', priority: 'high', agentId: agent.id, maxSteps: 8, deadline: new Date(Date.now() + 86400000).toISOString() }
  manager.start(); await manager.reconcile()
})
afterEach(async () => { await manager.stop(); db.db.close(); rmSync(dir, { recursive: true, force: true }) })

async function approve(a = agreement) {
  const r = manager.propose(scope(), a, input())
  await manager.act(r.id, r.revision, 'approve'); await manager.reconcile()
  return r
}
async function finish(step: ResponsibilityStep, action = 'done', next?: string) {
  const token = manager.tokenForTask(step.taskId)!
  await manager.report(manager.scopeForToken(token), { summary: `Evidence from ${step.phase} ${step.id}`, evidence: ['regression check passed'], checkout: dir, action, next })
  sessions.get(step.taskId)!.session.status = 'idle'
  await manager.reconcile()
}

describe('project work-agent default', () => {
  it.each(['delegate_responsibility', 'prepare_routine', 'goal', 'routine'])(
    'persists the default for %s and keeps admitted work pinned when it changes', async kind => {
      const worker = db.createAgent({ name: 'Work agent', config: { coding_agent: 'codex', model: 'worker-model', reasoning_effort: 'medium' } })!
      const request = input('Use Work agent by default for tasks, goals and recurring workflows.')
      const saved = await callResponsibilityTool(manager, manager.tokenForTask(scope().taskId)!, 'set_default_work_agent', { humanInputId: request, agentId: worker.id })
      expect(saved.isError).not.toBe(true)
      expect(JSON.stringify(saved)).toContain('Work agent')
      await manager.stop()
      manager = new ResponsibilityManager(db, runtime, vi.fn(), collect, inspect)
      manager.start(); await manager.reconcile()
      expect(snapshot().projects[0]).toMatchObject({ agentId: project.agentId, workAgentId: worker.id, workAgentInputId: request })
      expect(manager.context(scope())).toMatchObject({ workAgentId: worker.id })
      const humanInputId = input('Inspect the local fixture and report the findings.')
      const tool = kind === 'goal' || kind === 'routine' ? 'propose_responsibility' : kind
      const args = tool === 'propose_responsibility'
        ? { humanInputId, agreement: { ...agreement, agentId: undefined, kind, ...(kind === 'routine' ? { schedule: '* * * * *', source: { command: 'git', args: ['status'], description: 'Local status' } } : {}) } }
        : { humanInputId, title: 'Inspect the fixture' }
      const admitted = await callResponsibilityTool(manager, manager.tokenForTask(scope().taskId)!, tool, JSON.parse(JSON.stringify(args)))
      expect(admitted.isError).not.toBe(true)
      const r = snapshot().responsibilities[0]
      expect(r.agreement).toMatchObject({ agentId: worker.id, model: 'worker-model', reasoningEffort: 'medium' })
      manager.setDefaultWorkAgent(scope(), input('Use the original project agent for future work.'), project.agentId)
      if (r.state === 'proposed') {
        if (kind === 'routine') await manager.act(r.id, r.revision, 'trial')
        await manager.act(r.id, r.revision, 'approve')
        await manager.reconcile()
      }
      if (kind === 'routine') {
        collect.mockResolvedValueOnce('{"release":"red"}')
        db.db.prepare("UPDATE mastermind_agreements SET data=json_set(data, '$.nextAt', ?) WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), r.id)
      }
      await manager.reconcile()
      const step = snapshot().steps[0]
      expect(db.getTask(step.taskId)?.agent_id).toBe(worker.id)
      expect(runtime.startSession).toHaveBeenCalledWith(worker.id, step.taskId, expect.any(String))
      expect(snapshot().responsibilities[0].agreement.agentId).toBe(worker.id)
    }
  )

  it('uses an explicit task choice without changing the default and rejects a missing default agent', async () => {
    const worker = db.createAgent({ name: 'Work agent', config: { coding_agent: 'codex' } })!
    manager.setDefaultWorkAgent(scope(), input('Use Work agent by default.'), worker.id)
    const result = await callResponsibilityTool(manager, manager.tokenForTask(scope().taskId)!, 'delegate_responsibility', { humanInputId: input('Use the original agent for this request only.'), title: 'One override', agentId: project.agentId })
    expect(result.isError).not.toBe(true)
    expect(snapshot().responsibilities[0].agreement.agentId).toBe(project.agentId)
    expect(snapshot().projects[0].workAgentId).toBe(worker.id)
    db.deleteAgent(worker.id)
    expect(() => manager.delegate(scope(), input(), 'Missing default')).toThrow('available agent')
  })

  it('accepts defaults only from this project human conversation, never worker content or memory IDs', async () => {
    await approve()
    const r = snapshot().responsibilities[0]
    const step = snapshot().steps[0]
    const humanInputId = input('Use this agent by default.')
    const workerScope = manager.scopeForToken(manager.tokenForTask(step.taskId)!)
    expect(() => manager.setDefaultWorkAgent(workerScope, humanInputId, project.agentId)).toThrow('engineer request')
    expect((await callResponsibilityTool(manager, manager.tokenForTask(step.taskId)!, 'set_default_work_agent', { humanInputId, agentId: project.agentId })).isError).toBe(true)
    manager.rememberPreference(scope(), humanInputId)
    expect(() => manager.setDefaultWorkAgent(scope(), snapshot().memory[0].id, project.agentId)).toThrow('engineer request')
    mkdirSync(join(dir, 'other-project'))
    const other = manager.createProject('Other', join(dir, 'other-project'), project.agentId)
    const foreign = manager.recordHumanInput(projectConversationId(other.id), 'Use this agent.')!
    expect(() => manager.setDefaultWorkAgent(scope(), foreign.id, project.agentId)).toThrow('engineer request')
    expect(() => manager.setDefaultWorkAgent(scope(), humanInputId, 'missing')).toThrow('available agent')
    expect(snapshot().projects[0].workAgentId).toBeUndefined()
    expect(snapshot().responsibilities[0]).toEqual(r)
  })

  it('keeps Routine setup and its MCP discovery on the admitted agent after the default changes', async () => {
    const server = db.createMcpServer({ name: 'Work source', type: 'local', command: 'fixture' })!
    const worker = db.createAgent({ name: 'Work agent', config: { coding_agent: 'codex', mcp_servers: [server.id] } })!
    await manager.stop()
    manager = new ResponsibilityManager(db, runtime, vi.fn(), collect, inspect, new RoutineSources(db, vi.fn()))
    manager.start(); await manager.reconcile()
    manager.setDefaultWorkAgent(scope(), input('Use Work agent by default.'), worker.id)
    expect(await manager.sourceTools(scope())).toMatchObject({ agentId: worker.id, connections: [{ serverId: server.id }] })
    const request = input('Prepare a recurring check of this source.')
    manager.delegate(scope(), request, 'Prepare a check', undefined, undefined, true)
    await manager.reconcile(); await finish(snapshot().steps[0])
    const setup = snapshot().steps[1]
    manager.setDefaultWorkAgent(scope(), input('Use the original agent for future work.'), project.agentId)
    const setupScope = manager.scopeForToken(manager.tokenForTask(setup.taskId)!)
    expect(await manager.sourceTools(setupScope)).toMatchObject({ agentId: worker.id, connections: [{ serverId: server.id }] })
    expect(manager.context(setupScope)).toMatchObject({ workAgentId: worker.id, sourceConnections: [{ serverId: server.id }] })
    const proposal = manager.propose(setupScope, { ...agreement, agentId: undefined, kind: 'routine', schedule: '* * * * *' }, request)
    expect(proposal.agreement.agentId).toBe(worker.id)
  })
})

it('keeps quick decision questions short while retaining the full task findings', async () => {
  await approve()
  const step = snapshot().steps[0]
  const token = manager.tokenForTask(step.taskId)!
  const summary = 'Detailed investigation findings. '.repeat(40).trim()
  const report = { action: 'ask', summary, evidence: ['The project has two configured databases.'], checkout: dir }
  const rejected = await callResponsibilityTool(manager, token, 'report_responsibility', { ...report, next: 'x'.repeat(601) })
  expect(rejected.isError).toBe(true)
  expect(JSON.stringify(rejected)).toContain('600 characters')
  expect(snapshot().steps[0].report).toBeNull()
  expect(snapshot().notices).toHaveLength(0)

  const question = 'Question: Which database should I check?\nWhy: The project has two database connections.\nReply: Production or staging.'
  const accepted = await callResponsibilityTool(manager, token, 'report_responsibility', { ...report, next: question })
  expect(accepted.isError).not.toBe(true)
  sessions.get(step.taskId)!.session.status = 'idle'
  await manager.reconcile()
  expect(snapshot().notices[0]).toMatchObject({ kind: 'question', body: question, stepId: step.id })
  expect(snapshot().steps[0].report).toMatchObject({ summary, evidence: report.evidence })
  expect(db.getTask(step.taskId)?.resolution).toBe(summary)
})

it.each(['delegate_responsibility', 'prepare_routine'])('stores a display summary through %s without rewriting the human request', async tool => {
  const request = 'Inspect the deployment and database every ten minutes. Read only; stop when both verify the fix.'
  const humanInputId = input(request)
  const token = manager.tokenForTask(projectConversationId(project.id))!
  const result = await callResponsibilityTool(manager, token, tool, { humanInputId, title: 'Verify the release', summary: 'Check the release and saved data until the fix is verified.' })
  expect(result.isError).not.toBe(true)
  expect(snapshot().responsibilities[0].agreement).toMatchObject({ summary: 'Check the release and saved data until the fix is verified.', objective: request, scope: request })
  expect(() => manager.propose(scope(), { ...agreement, summary: 'x'.repeat(241) }, humanInputId)).toThrow('240 characters')
})

describe('deleting inactive proposals through Mastermind', () => {
  let service: TaskControl
  let confirm: ReturnType<typeof vi.fn<ConstructorParameters<typeof TaskControl>[4]>>
  const rootCall = (name: string, args: Record<string, unknown>) => callResponsibilityTool(manager, manager.tokenForTask(projectConversationId(project.id))!, name, args)

  beforeEach(() => {
    confirm = vi.fn(async () => true)
    service = new TaskControl(db, { withStoppedTasks: vi.fn() }, { completeTask: vi.fn() }, manager, confirm, vi.fn())
    manager.setTaskControl(service)
  })
  afterEach(async () => { await service.stop() })

  it('discovers and deletes Goal/Routine proposals over real HTTP, retaining source evidence and unrelated data', async () => {
    const human = input('Propose a goal and a recurring workflow')
    const goal = manager.propose(scope(), agreement, human)
    const routine = manager.propose(scope(), { ...agreement, kind: 'routine', title: 'Recurring project updates', schedule: '*/5 * * * *', source: { command: 'test-source', args: [], description: 'Project updates' } }, human)
    await manager.act(routine.id, routine.revision, 'trial')
    manager.remember(project.id, 'preference', 'Keep updates brief')
    writeFileSync(join(dir, 'evidence.txt'), 'keep this evidence')
    const ordinary = db.createTask({ title: 'Unrelated task' })!
    setTaskControl(service); setResponsibilityManager(manager)
    const port = await startTaskApiServer(db)
    const client = new Client({ name: 'proposal-deletion-test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?artifact=mastermind-session`)))
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args })
      return JSON.parse((result.content as Array<{ text: string }>)[0].text)
    }
    try {
      expect((await client.listTools()).tools.map(t => t.name)).toContain('delete_responsibility_proposal')
      expect(await call('inspect_responsibilities', { query: 'Recurring project' })).toMatchObject([{ id: routine.id, kind: 'routine', state: 'proposed' }])
      confirm.mockResolvedValueOnce(false)
      expect(await call('delete_responsibility_proposal', { responsibility_id: goal.id, approved: true })).toMatchObject({ success: false, cancelled: true })
      expect(snapshot().responsibilities).toHaveLength(2)
      expect(await rootCall('delete_responsibility_proposal', { responsibility_id: goal.id })).not.toHaveProperty('isError', true)
      expect(await call('delete_responsibility_proposal', { responsibility_id: routine.id })).toMatchObject({ success: true, deleted: true, responsibilityId: routine.id })
      expect(confirm.mock.calls.at(-1)![0].detail).toContain(`Proposal: ${routine.id}`)
      expect(snapshot().responsibilities).toEqual([])
      const retained = JSON.parse((db.db.prepare('SELECT data FROM mastermind_agreements WHERE id = ?').get(routine.id) as { data: string }).data)
      expect(retained).toMatchObject({ state: 'cancelled', deletedAt: expect.any(String), trial: { output: '{"release":"green"}' } })
      expect(manager.propose(scope(), agreement, human).deletedAt).toBeTruthy()
      await expect(manager.act(goal.id, goal.revision, 'approve')).rejects.toThrow('deleted')
      expect(db.getTask(ordinary.id)).toBeDefined()
      expect(snapshot().memory).toHaveLength(1)
      expect(readFileSync(join(dir, 'evidence.txt'), 'utf8')).toBe('keep this evidence')
      await manager.reconcile()
      expect(runtime.startSession).not.toHaveBeenCalled()
      const reopened = new ResponsibilityManager(db, runtime)
      expect(reopened.snapshot().responsibilities).toEqual([])
    } finally {
      await client.close(); stopTaskApiServer(); setTaskControl(undefined); setResponsibilityManager(undefined)
    }
  })

  it('rejects cross-project and worker deletion, and refuses an agreement activated during confirmation', async () => {
    const proposal = manager.propose(scope(), agreement, input())
    mkdirSync(join(dir, 'other'))
    const other = manager.createProject('Other project', join(dir, 'other'), project.agentId)
    await expect(service.deleteProposal({ responsibility_id: proposal.id }, other.id)).rejects.toThrow('another project')
    expect(confirm).not.toHaveBeenCalled()
    confirm.mockImplementationOnce(async () => { await manager.act(proposal.id, proposal.revision, 'approve'); return true })
    await expect(service.deleteProposal({ responsibility_id: proposal.id })).rejects.toThrow('inactive proposals')
    await manager.reconcile()
    const step = snapshot().steps[0]
    const worker = manager.tokenForTask(step.taskId)!
    expect((await callResponsibilityTool(manager, worker, 'delete_responsibility_proposal', { responsibility_id: proposal.id })).isError).toBe(true)
    expect(snapshot().responsibilities[0].state).toBe('active')
  })

  it('rejects stale confirmation and unfinished source trials without losing the proposal', async () => {
    const proposal = manager.propose(scope(), { ...agreement, kind: 'routine', schedule: '* * * * *', source: { command: 'test-source', args: [], description: 'Project updates' } }, input())
    confirm.mockImplementationOnce(async () => { manager.propose(scope(), { ...proposal.agreement, title: 'Revised goal' }, input('Revise the proposal'), proposal.id); return true })
    await expect(service.deleteProposal({ responsibility_id: proposal.id })).rejects.toThrow('changed while confirmation')
    let finishCollection!: (value: string) => void
    collect.mockImplementationOnce(() => new Promise(resolve => { finishCollection = resolve }))
    const trial = manager.act(proposal.id, 2, 'trial')
    await expect(service.deleteProposal({ responsibility_id: proposal.id })).rejects.toThrow('source trial')
    finishCollection('{"release":"green"}'); await trial
    expect(snapshot().responsibilities).toHaveLength(1)
    expect(await service.deleteProposal({ responsibility_id: proposal.id })).toMatchObject({ success: true })
  })

  it('shares the confirmation lock with task actions and leaves proposals intact on quit', async () => {
    const proposal = manager.propose(scope(), agreement, input())
    const task = db.createTask({ title: 'Ordinary task' })!
    confirm.mockImplementationOnce(({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve(false), { once: true })))
    const pending = service.deleteProposal({ responsibility_id: proposal.id })
    await expect(service.run({ task_id: task.id, action: 'delete' })).rejects.toThrow('already waiting')
    await service.stop()
    expect(await pending).toMatchObject({ success: false, cancelled: true })
    expect(snapshot().responsibilities).toHaveLength(1)
    expect(db.getTask(task.id)).toBeDefined()
  })
})

describe('durable engineering responsibilities', () => {
  it('expands pasted home paths while retaining canonical folder validation and deduplication', () => {
    const folder = join(dir, 'Project with spaces')
    mkdirSync(folder)
    const saved = manager.createProject('Pasted folder', `~/${relative(homedir(), folder)}`, project.agentId)
    expect(saved.root).toBe(realpathSync(folder))
    expect(manager.createProject('Same folder', folder, project.agentId).id).toBe(saved.id)
    expect(() => manager.createProject('Missing folder', join(dir, 'missing'), project.agentId)).toThrow('Select an existing folder')
    const file = join(dir, 'file.txt')
    writeFileSync(file, 'not a folder')
    expect(() => manager.createProject('File', file, project.agentId)).toThrow('Choose a project folder')
  })

  it('lets the project root delete a batch with one approval and no replacement work', async () => {
    await approve()
    const step = snapshot().steps[0]
    const second = db.createTask({ title: 'Another disposable task' })!
    const token = manager.tokenForTask(step.taskId)!
    const confirm = vi.fn(async () => true)
    const service = new TaskControl(db, { withStoppedTasks: async (_ids, action, beforeStop) => { await beforeStop?.(); return action() } }, { completeTask: vi.fn() }, manager, confirm, vi.fn())
    manager.setTaskControl(service)
    vi.spyOn(db, 'deleteTaskAttachments').mockImplementation(() => {})
    expect((await callResponsibilityTool(manager, token, 'manage_task', { task_ids: [step.taskId, second.id], action: 'delete' })).isError).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    const root = manager.tokenForTask(projectConversationId(project.id))!
    const inspected = await callResponsibilityTool(manager, root, 'inspect_tasks', { task_id: step.taskId })
    expect(JSON.stringify(inspected)).toContain(step.taskId)
    const result = await callResponsibilityTool(manager, root, 'manage_task', { task_ids: [step.taskId, second.id], action: 'delete' })
    expect(result.isError).not.toBe(true)
    expect(db.getTask(step.taskId)).toBeUndefined()
    expect(db.getTask(second.id)).toBeUndefined()
    expect(confirm).toHaveBeenCalledOnce()
    expect(snapshot().responsibilities[0].state).toBe('cancelled')
    await manager.reconcile()
    expect(snapshot().steps).toHaveLength(1)
    expect(runtime.startSession).toHaveBeenCalledTimes(1)
    await service.stop()
  })

  it('keeps proposals inactive and human permissions out of worker tools', async () => {
    const r = manager.propose(scope(), agreement, input())
    await manager.reconcile()
    expect(runtime.startSession).not.toHaveBeenCalled()
    expect(() => manager.propose(scope(), agreement, 'invented-human-input')).toThrow('recorded human')
    await manager.act(r.id, r.revision, 'approve'); await manager.reconcile()
    const step = snapshot().steps[0]
    const token = manager.tokenForTask(step.taskId)!
    const result = await callResponsibilityTool(manager, token, 'propose_responsibility', { agreement, approved: true })
    expect(result.isError).toBe(true)
    expect(() => manager.remember(project.id, 'permission' as 'fact', 'May deploy')).toThrow('Permission belongs')
  })

  it('runs a direct Task once, returns its result, and keeps follow-up evidence', async () => {
    const message = input('Review this change only')
    const r = manager.delegate(scope(), message, 'Review change')
    expect(manager.delegate(scope(), message, 'Duplicate request').id).toBe(r.id)
    await manager.reconcile()
    expect(snapshot().steps).toHaveLength(1)
    await finish(snapshot().steps[0])
    expect(snapshot().responsibilities[0].state).toBe('completed')
    expect(snapshot().notices[0].kind).toBe('result')
    expect(runtime.stopSession).toHaveBeenCalledTimes(1)
    const follow = manager.delegate(scope(), input('Plan based on that review'), 'Plan', r.id)
    await manager.reconcile()
    expect(follow.workspace).toBe(dir)
    expect(db.getTask(snapshot().steps[1].taskId)!.description).toContain('Evidence from work')
  })

  it('lets a human clarification renew one direct Task assignment without creating a Goal', async () => {
    manager.delegate(scope(), input('Review the change'), 'Review')
    await manager.reconcile(); await finish(snapshot().steps[0], 'ask', 'Which behavior is expected?')
    await manager.answer(snapshot().notices[0].id, 'Preserve the existing behavior'); await manager.reconcile()
    expect(snapshot().steps).toHaveLength(2)
    expect(snapshot().responsibilities[0].agreement.kind).toBe('task')
    expect(snapshot().responsibilities[0].agreement.maxSteps).toBe(2)
    await finish(snapshot().steps[1])
    expect(snapshot().responsibilities[0].state).toBe('completed')
  })

  it('releases cancelled ambiguous work only after inspection, without restarting it', async () => {
    const r = await approve()
    vi.mocked(runtime.stopSession).mockRejectedValueOnce(new Error('Uncertain stop'))
    await expect(manager.act(r.id, r.revision, 'cancel')).rejects.toThrow('Uncertain stop')
    expect(snapshot().responsibilities[0].state).toBe('cancelled')
    await expect(manager.act(r.id, r.revision, 'recover')).rejects.toThrow('still present')
    sessions.clear()
    await manager.act(r.id, r.revision, 'recover'); await manager.reconcile()
    expect(snapshot().responsibilities[0].state).toBe('cancelled')
    expect(snapshot().steps[0].state).toBe('held')
    expect(runtime.startSession).toHaveBeenCalledTimes(1)
  })

  it('progresses a Goal through independent verification and only then completes', async () => {
    await approve()
    const work = snapshot().steps[0]
    await finish(work)
    expect(snapshot().steps.map(s => s.phase)).toEqual(['work', 'verify'])
    expect(snapshot().responsibilities[0].state).toBe('active')
    expect(snapshot().notices).toHaveLength(0)
    const verify = snapshot().steps[1]
    expect(verify.expectedWork).toEqual(evidence())
    await finish(verify)
    expect(snapshot().responsibilities[0].state).toBe('completed')
    expect(snapshot().notices.filter(n => n.kind === 'result')).toHaveLength(1)
    expect(sessions.size).toBe(0)
  })

  it('observes results during pause but admits no next Goal step', async () => {
    const r = await approve()
    await manager.act(r.id, r.revision, 'pause')
    await finish(snapshot().steps[0])
    expect(snapshot().steps).toHaveLength(1)
    expect(snapshot().responsibilities[0].state).toBe('paused')
    await manager.act(r.id, r.revision, 'resume'); await manager.reconcile()
    expect(snapshot().steps[1].phase).toBe('verify')
  })

  it('fences an uncertain launch across restart without retrying it', async () => {
    vi.mocked(runtime.startSession).mockRejectedValueOnce(new Error('Acknowledgement timeout'))
    await approve()
    expect(snapshot().steps[0].state).toBe('unknown')
    await manager.reconcile(); await manager.stop()
    manager = new ResponsibilityManager(db, runtime, vi.fn(), collect, inspect)
    manager.start(); await manager.reconcile()
    expect(runtime.startSession).toHaveBeenCalledTimes(1)
    expect(snapshot().responsibilities[0].state).toBe('blocked')
    expect(snapshot().notices).toHaveLength(1)
  })

  it('stops at the agreed budget instead of skipping verification', async () => {
    await approve({ ...agreement, maxSteps: 1 })
    await finish(snapshot().steps[0])
    expect(snapshot().responsibilities[0].state).toBe('blocked')
    expect(snapshot().notices[0].body).toContain('limit')
    expect(runtime.startSession).toHaveBeenCalledTimes(1)
  })

  it('refuses completion against a different working revision', async () => {
    await approve(); await finish(snapshot().steps[0])
    const verify = snapshot().steps[1]
    inspect.mockResolvedValueOnce({ ...evidence(), revision: 'different' })
    await expect(manager.report(manager.scopeForToken(manager.tokenForTask(verify.taskId)!), { action: 'done', summary: 'pass', evidence: ['test'], checkout: dir })).rejects.toThrow('changed')
    expect(snapshot().responsibilities[0].state).toBe('active')
  })

  it('preserves each question and delivers an exact answer only once', async () => {
    await approve(); await finish(snapshot().steps[0], 'ask', 'Which expected behavior should the test use?')
    const question = snapshot().notices[0]
    await manager.answer(question.id, 'Preserve the existing behavior')
    await expect(manager.answer(question.id, 'A second answer')).rejects.toThrow('already')
    await manager.reconcile()
    expect(snapshot().steps[1].instruction).toContain('Preserve the existing behavior')
    expect(snapshot().responsibilities[0].approvedRevision).toBe(1)
  })

  it('rejects expired native checkpoints without replying to another session', async () => {
    await approve()
    const step = snapshot().steps[0]
    const live = sessions.get(step.taskId)!
    live.session.status = 'waiting_approval'
    manager.observe('agent:output', { taskId: step.taskId, sessionId: live.sessionId, data: { partType: 'question', content: 'Allow?', tool: { name: 'permission', requestId: 'exact-request' } } })
    const notice = snapshot().notices[0]
    live.sessionId = 'replacement-session'
    await expect(manager.answer(notice.id, 'Yes', true)).rejects.toThrow('no longer live')
    expect(runtime.respondToPermission).not.toHaveBeenCalled()
    expect(snapshot().notices[0].state).toBe('expired')
  })

  it('revokes worker authority on takeover and creates a fresh assignment on handback', async () => {
    const r = await approve(); const step = snapshot().steps[0]
    const token = manager.tokenForTask(step.taskId)!
    await manager.act(r.id, r.revision, 'takeover')
    expect(() => manager.scopeForToken(token)).toThrow('expired')
    expect(sessions.size).toBe(0)
    await manager.reconcile(); expect(runtime.startSession).toHaveBeenCalledTimes(1)
    manager.recordHumanInput(step.taskId, 'I made a local correction')
    await manager.act(r.id, r.revision, 'handback'); await manager.reconcile()
    expect(snapshot().steps[1].id).not.toBe(step.id)
    expect(snapshot().steps[1].instruction).toContain('current working files')
  })

  it('retains a result but fences uncertain cleanup before the next assignment', async () => {
    const r = await approve()
    vi.mocked(runtime.stopSession).mockRejectedValueOnce(new Error('Native stop timed out'))
    await finish(snapshot().steps[0])
    expect(snapshot().steps[0].state).toBe('releasing')
    expect(snapshot().steps[0].report).not.toBeNull()
    expect(snapshot().responsibilities[0].state).toBe('blocked')
    await manager.reconcile()
    expect(runtime.startSession).toHaveBeenCalledTimes(1)
    await expect(manager.act(r.id, r.revision, 'recover')).rejects.toThrow('still present')
    sessions.clear() // The engineer inspected and stopped the exact prior runtime.
    await manager.act(r.id, r.revision, 'recover'); await manager.reconcile()
    expect(snapshot().steps[1].phase).toBe('verify')
  })

  it('expires native and callback permissions on quit and reopens interrupted work without replay', async () => {
    const r = await approve(); const step = snapshot().steps[0]
    const config = { taskId: step.taskId, agentId: project.agentId, workspaceDir: dir }
    manager.configureSession(config, 1234)
    const configured = config as import('./adapters/coding-agent-adapter').SessionConfig
    const answer = configured.authorizeTool!('Bash', { command: 'external action' }, 'callback-request', new AbortController().signal)
    expect(snapshot().notices[0].kind).toBe('permission')
    await manager.stop(); expect(await answer).toBe(false)
    sessions.clear() // index.ts stops AgentManager during full quit.
    manager = new ResponsibilityManager(db, runtime, vi.fn(), collect, inspect)
    manager.start(); await manager.reconcile()
    expect(snapshot().notices[0].state).toBe('expired')
    expect(snapshot().responsibilities[0].state).toBe('blocked')
    expect(runtime.startSession).toHaveBeenCalledTimes(1)
    await expect(manager.answer(snapshot().notices[0].id, 'Approved', true)).rejects.toThrow('expired')
    await manager.act(r.id, r.revision, 'recover'); await manager.reconcile()
    expect(snapshot().steps).toHaveLength(2)
  })

  it('rejects queued tool permission after takeover and accepts exact structured question answers', async () => {
    const r = await approve(); const step = snapshot().steps[0]
    const config: import('./adapters/coding-agent-adapter').SessionConfig = { taskId: step.taskId, agentId: project.agentId, workspaceDir: dir }
    manager.configureSession(config, 1234)
    const nativePart = { partType: 'question', tool: { name: 'AskUserQuestion', questions: [] } }
    manager.observe('agent:output', { taskId: step.taskId, sessionId: sessions.get(step.taskId)!.sessionId, data: nativePart })
    expect(nativePart.partType).toBe('text')
    expect(nativePart.tool).toBeUndefined()
    const pending = config.authorizeTool!('Bash', { command: 'external operation' }, 'old-owner', new AbortController().signal)
    const old = snapshot().notices[0]
    await manager.act(r.id, r.revision, 'takeover')
    expect(await pending).toBe(false)
    await expect(manager.answer(old.id, 'Approved', true)).rejects.toThrow('expired')
    manager.configureSession(config, 1234)
    expect(config.systemPrompt).toContain('follow-up conversation')
    expect(await config.authorizeTool!('Read', { file_path: join(dir, 'file') }, 'human-read', new AbortController().signal)).toBe(true)
    const questions = [{ question: 'Which behavior?', header: 'Behavior' }, { question: 'Which test?', header: 'Test' }]
    const waiting = config.authorizeTool!('AskUserQuestion', { questions }, 'human-question', new AbortController().signal)
    const notice = snapshot().notices.at(-1)!
    expect(notice.questions).toEqual(questions)
    await expect(manager.answer(notice.id, JSON.stringify({ 'Which behavior?': 'Keep it' }))).rejects.toThrow('Test')
    const answers = { 'Which behavior?': 'Keep it', 'Which test?': 'Regression test' }
    await manager.answer(notice.id, JSON.stringify(answers))
    expect(await waiting).toEqual({ questions, answers })
  })

  it('never marks a stale request in the same live session answered', async () => {
    await approve(); const step = snapshot().steps[0]; const live = sessions.get(step.taskId)!
    live.session.status = 'waiting_approval'
    manager.observe('agent:output-batch', { taskId: step.taskId, sessionId: live.sessionId, messages: [{ partType: 'question', content: 'Allow this exact action?', tool: { name: 'permission', requestId: 'old-request' } }] })
    vi.mocked(runtime.respondToPermission).mockResolvedValueOnce(false)
    await manager.answer(snapshot().notices[0].id, 'Approved', true)
    expect(snapshot().notices[0].state).toBe('expired')
    expect(runtime.respondToPermission).toHaveBeenCalledWith(live.sessionId, true, 'Approved', undefined, 'permission', 'old-request')
  })

  it('preserves takeover while a report settlement check is in flight', async () => {
    const r = await approve(); const step = snapshot().steps[0]
    await manager.report(manager.scopeForToken(manager.tokenForTask(step.taskId)!), { summary: 'Finished', evidence: ['Check passed'], checkout: dir, action: 'done' })
    sessions.get(step.taskId)!.session.status = 'idle'
    let release!: (value: WorkEvidence) => void
    inspect.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const tick = manager.reconcile()
    await manager.act(r.id, r.revision, 'takeover')
    release(evidence()); await tick
    expect(snapshot().responsibilities[0].state).toBe('taken_over')
    expect(snapshot().steps[0].state).toBe('held')
    expect(snapshot().notices.filter(n => n.kind === 'result')).toHaveLength(0)
  })

  it('shares a running task with the engineer and Mastermind, fencing stale reports', async () => {
    await approve(); const step = snapshot().steps[0]
    const worker = manager.scopeForToken(manager.tokenForTask(step.taskId)!)
    expect(manager.recordHumanInput(step.taskId, 'Please explain the finding')).toBeTruthy()
    await manager.prepareTaskMessage(step.taskId)
    expect(manager.taskMessageContext(step.taskId)).toContain('inputRevision is 1')
    await expect(manager.report(worker, { summary: 'Old answer', evidence: ['check'], checkout: dir, action: 'done' })).rejects.toThrow('Current inputRevision is 1')
    await expect(manager.report(worker, { summary: 'Updated answer', evidence: ['check'], checkout: dir, action: 'done', inputRevision: 1 })).resolves.toBeDefined()
    const sent = await callResponsibilityTool(manager, manager.tokenForTask(scope().taskId)!, 'send_message', { task_id: step.taskId, text: 'Explain this to me too' })
    expect(sent.isError).not.toBe(true)
    expect(runtime.sendByTaskId).toHaveBeenCalledWith(step.taskId, expect.stringContaining('human_authored=false'))
    expect(runtime.sendByTaskId).toHaveBeenCalledWith(step.taskId, expect.stringContaining('Explain this to me too'))
    await expect(manager.messageTask(worker, { task_id: step.taskId, text: 'Other task' })).rejects.toThrow('Only the active Mastermind')
    expect(() => manager.guardLegacyRoute('/send_message', { task_id: step.taskId })).not.toThrow()
    expect(snapshot().steps).toHaveLength(1)
  })
  it('preserves a human message revision received while the worker is launching', async () => {
    vi.mocked(runtime.startSession).mockImplementationOnce(async (_agent, taskId) => {
      manager.recordHumanInput(taskId, 'Include the new requirement')
      await manager.prepareTaskMessage(taskId)
      const live = { sessionId: `session-${taskId}`, session: { workspaceDir: dir, status: 'working' } }
      sessions.set(taskId, live)
      return live.sessionId
    })
    await approve()
    const step = snapshot().steps[0]
    expect(step).toMatchObject({ state: 'running', inputRevision: 1 })
    await expect(manager.report(manager.scopeForToken(manager.tokenForTask(step.taskId)!), { summary: 'Stale answer', evidence: ['check'], checkout: dir, action: 'done', inputRevision: 0 })).rejects.toThrow('Current inputRevision is 1')
  })

  it.each([false, true])('invalidates an in-flight settlement when a new message arrives (files changed: %s)', async changed => {
    await approve(); const step = snapshot().steps[0]
    await manager.report(manager.scopeForToken(manager.tokenForTask(step.taskId)!), { summary: 'Finished', evidence: ['check'], checkout: dir, action: 'done' })
    sessions.get(step.taskId)!.session.status = 'idle'
    let release!: (value: WorkEvidence) => void
    inspect.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const tick = manager.reconcile()
    await manager.prepareTaskMessage(step.taskId)
    release({ ...evidence(), ...(changed ? { fingerprint: 'new-input-files' } : {}) }); await tick
    expect(snapshot().steps[0]).toMatchObject({ state: 'running', report: null, inputRevision: 1 })
    expect(runtime.stopSession).not.toHaveBeenCalled()
    expect(snapshot().notices.filter(n => n.kind === 'result')).toHaveLength(0)
  })

  it.each(['settled', 'unknown'])('allows direct conversation after a %s assignment without restarting automation', async state => {
    const r = manager.delegate(scope(), input(), 'Inspect the fixture'); await manager.reconcile()
    const step = snapshot().steps[0]
    if (state === 'settled') await finish(step)
    else { sessions.clear(); await manager.reconcile() }
    const before = snapshot().responsibilities[0].state
    const config = { taskId: step.taskId, agentId: project.agentId, workspaceDir: '/default', systemPrompt: '', mcpServers: { existing: { type: 'http' as const, url: 'http://localhost/tools' } }, model: 'chosen-model' }
    manager.configureSession(config, 1234)
    expect(realpathSync(config.workspaceDir)).toBe(realpathSync(dir))
    expect(config.mcpServers).toHaveProperty('existing')
    expect(config.systemPrompt).toContain('follow-up conversation')
    expect(config).not.toHaveProperty('responsibilityRole')
    expect(manager.recordHumanInput(step.taskId, 'What happened?')).toBeTruthy()
    await manager.prepareTaskMessage(step.taskId)
    await manager.reconcile()
    expect(snapshot().responsibilities.find(record => record.id === r.id)?.state).toBe(before)
    expect(runtime.startSession).toHaveBeenCalledTimes(1)
  })

  it('starts the saved assignment once even with an interrupted task in the same project', async () => {
    const first = await approve(); const oldStep = snapshot().steps[0]
    sessions.clear(); await manager.reconcile()
    const request = input('Investigate why tickets keep appearing')
    const next = manager.delegate(scope(), request, 'Find the recurring ticket cause')
    await manager.reconcile(); await manager.reconcile()
    expect(manager.delegate(scope(), request, 'Find the recurring ticket cause').id).toBe(next.id)
    expect(snapshot().steps.filter(s => s.responsibilityId === next.id)).toHaveLength(1)
    expect(snapshot().responsibilities.find(r => r.id === first.id)?.state).toBe('blocked')
    expect(db.getTask(oldStep.taskId)).toBeDefined()
    expect(runtime.startSession).toHaveBeenCalledTimes(2)
  })

  it('runs independent tasks in the same project without sharing another project permission', async () => {
    const first = await approve()
    const other = manager.propose(scope(), { ...agreement, title: 'Other goal' }, input('Do another change'))
    await manager.act(other.id, other.revision, 'approve'); await manager.reconcile()
    expect(runtime.startSession).toHaveBeenCalledTimes(2)
    const elsewhere = join(dir, 'other'); mkdirSync(elsewhere)
    const p = manager.createProject('Other project', elsewhere, project.agentId)
    const otherScope = manager.scopeForToken(manager.tokenForTask(projectConversationId(p.id))!)
    expect(() => manager.propose(otherScope, { ...agreement, basedOn: first.id }, input())).toThrow('recorded human')
    await expect(manager.messageTask(otherScope, { task_id: snapshot().steps[0].taskId, text: 'Cross-project message' })).rejects.toThrow('another project')
    expect(() => manager.guardLegacyRoute('/start_task', { task_id: snapshot().steps[0].taskId })).toThrow('scoped responsibility')
  })
})

describe('learned routines', () => {
  async function routine(source = true) {
    const r = manager.propose(scope(), { ...agreement, kind: 'routine', schedule: '* * * * *', source: source ? { command: 'gh', args: ['api', 'repos/example/project'], description: 'Release status' } : undefined }, input('Watch releases'))
    if (source) {
      await expect(manager.act(r.id, r.revision, 'approve')).rejects.toThrow('trial')
      await manager.act(r.id, r.revision, 'trial')
    }
    await manager.act(r.id, r.revision, 'approve'); await manager.reconcile()
    return r
  }
  function due(id: string) {
    db.db.prepare("UPDATE mastermind_agreements SET data=json_set(data, '$.nextAt', ?) WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), id)
  }
  it('requires a real trial, skips unchanged data, and handles changed data once', async () => {
    const r = await routine()
    due(r.id); await manager.reconcile()
    expect(runtime.startSession).not.toHaveBeenCalled()
    collect.mockResolvedValue('{"release":"failed"}')
    due(r.id); await manager.reconcile()
    expect(snapshot().steps[0].phase).toBe('classify')
    await finish(snapshot().steps[0], 'notify')
    due(r.id); await manager.reconcile()
    expect(runtime.startSession).toHaveBeenCalledTimes(1)
    expect(snapshot().notices).toHaveLength(1)
    expect(snapshot().responsibilities[0].state).toBe('active')
  })
  it('handles repeated source transitions without retaining settled worker processes', async () => {
    const r = await routine()
    for (let i = 0; i < 6; i++) {
      collect.mockResolvedValue(i % 2 ? '{"release":"green"}' : '{"release":"failed"}')
      due(r.id); await manager.reconcile()
      await finish(snapshot().steps.at(-1)!, 'notify')
      expect(sessions.size).toBe(0)
    }
    expect(snapshot().steps).toHaveLength(6)
    expect(snapshot().notices).toHaveLength(6)
  })
  it('delivers fixed reminders without any model turn', async () => {
    const r = await routine(false); due(r.id); await manager.reconcile()
    expect(runtime.startSession).not.toHaveBeenCalled()
    expect(collect).not.toHaveBeenCalled()
    expect(snapshot().notices[0].kind).toBe('result')
  })
  it('reports collection failure without advancing its successful baseline', async () => {
    const r = await routine(); const cursor = snapshot().responsibilities[0].cursor
    collect.mockRejectedValueOnce(new Error('Source unavailable')); due(r.id); await manager.reconcile()
    expect(snapshot().responsibilities[0].cursor).toBe(cursor)
    expect(snapshot().responsibilities[0].state).toBe('blocked')
    expect(runtime.startSession).not.toHaveBeenCalled()
    collect.mockResolvedValue('{"release":"green"}')
    await manager.act(r.id, r.revision, 'recover'); await manager.reconcile()
    expect(runtime.startSession).not.toHaveBeenCalled()
    expect(snapshot().responsibilities[0].state).toBe('active')
  })
})

describe('real bounded source and working-file checks', () => {
  it('collects a finite program and hashes changed uncommitted files', async () => {
    const result = await collectSource({ command: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify({b:2,a:1}))'], description: 'Local source fixture' }, dir, new AbortController().signal)
    expect(result).toBe('{"a":1,"b":2}')
    writeFileSync(join(dir, 'example.txt'), 'before')
    const before = await captureWork(dir)
    writeFileSync(join(dir, 'example.txt'), 'after')
    expect((await captureWork(dir)).fingerprint).not.toBe(before.fingerprint)
  })
})

describe('dynamic source collection lifecycle', () => {
  let sources: RoutineSources
  beforeEach(async () => {
    await manager.stop()
    sources = new RoutineSources(db, async () => { throw new Error('No external connection needed in this lifecycle test.') })
    vi.spyOn(sources, 'collect').mockImplementation((s, root, signal) => collect(s, root, signal))
    manager = new ResponsibilityManager(db, runtime, vi.fn(), collect, inspect, sources)
    manager.start(); await manager.reconcile()
  })
  function propose(reasoning?: string) {
    return manager.propose(scope(), { ...agreement, kind: 'routine', schedule: '* * * * *', source: {
      kind: 'collection', description: 'Learned monitoring', reads: [{ kind: 'command', command: 'git', args: ['status', '--porcelain'], description: 'Current checkout' }], reasoning
    } }, input('Keep watching the selected source within this scope.'))
  }
  function due(id: string) {
    db.db.prepare("UPDATE mastermind_agreements SET data=json_set(data, '$.nextAt', ?) WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), id)
  }
  it.each(['pi', 'opencode', 'cursor'] as const)('keeps deterministic sources available on %s but rejects reasoning without native-tool isolation', backend => {
    db.updateAgent(agreement.agentId, { config: { coding_agent: backend } })
    expect(propose().agreement.source).toBeDefined()
    expect(() => propose('Extract only the supplied evidence.')).toThrow('requires a Codex or Claude Code agent')
    expect(runtime.startSession).not.toHaveBeenCalled()
  })
  async function finishCollection(value: string) {
    const step = snapshot().steps.filter(s => s.phase === 'collect').at(-1)!
    await manager.report(manager.scopeForToken(manager.tokenForTask(step.taskId)!), { summary: 'Extracted source facts', evidence: ['Supplied source evidence'], checkout: dir, action: 'done', sourceSnapshot: value })
    sessions.get(step.taskId)!.session.status = 'idle'; await manager.reconcile()
  }
  it('uses the existing trial, skips unchanged collection, and preserves progress on failure', async () => {
    const r = propose(); await manager.act(r.id, r.revision, 'trial'); await manager.act(r.id, r.revision, 'approve'); await manager.reconcile()
    due(r.id); await manager.reconcile()
    expect(runtime.startSession).not.toHaveBeenCalled()
    expect(snapshot().responsibilities[0].lastCollectedAt).toBeTruthy()
    const cursor = snapshot().responsibilities[0].cursor
    collect.mockRejectedValueOnce(new Error('Second source incomplete'))
    due(r.id); await manager.reconcile()
    expect(snapshot().responsibilities[0].cursor).toBe(cursor)
    expect(snapshot().responsibilities[0].state).toBe('blocked')
    expect(snapshot().notices.at(-1)?.body).toContain('not an unchanged source')
    await manager.act(r.id, r.revision, 'recover'); await manager.reconcile()
    collect.mockResolvedValue('changed source'); due(r.id); await manager.reconcile()
    await finish(snapshot().steps[0], 'notify')
    due(r.id); await manager.reconcile()
    expect(runtime.startSession).toHaveBeenCalledTimes(1)
  })
  it('runs a human-triggered reasoning trial with no native tools, then budgets each collection', async () => {
    const r = propose('Extract the stable release state from the supplied evidence.')
    await manager.act(r.id, r.revision, 'trial')
    const step = snapshot().steps[0]
    expect(step.collection?.trial).toBe(true)
    expect(snapshot().responsibilities[0].trial).toBeNull()
    await expect(manager.act(r.id, r.revision, 'approve')).rejects.toThrow('trial')
    const config = { taskId: step.taskId, agentId: agreement.agentId, workspaceDir: dir }
    manager.configureSession(config, 12345)
    expect(config).toMatchObject({ responsibilityRole: 'collector', tools: { bash: false, read: false }, sandboxMode: 'read-only' })
    const authorize = (config as unknown as { authorizeTool: (name: string, args: object, id: string, signal: AbortSignal) => Promise<boolean> }).authorizeTool
    expect(await authorize('Bash', { command: 'echo wrong' }, 'tool-1', new AbortController().signal)).toBe(false)
    await finishCollection('{"release":"green"}')
    expect(inspect).not.toHaveBeenCalled()
    expect(snapshot().responsibilities[0].trial?.output).toBe('{"release":"green"}')
    expect(snapshot().steps[0].state).toBe('settled')
    await manager.act(r.id, r.revision, 'approve'); await manager.reconcile(); due(r.id); await manager.reconcile()
    await finishCollection('{"release":"green"}')
    expect(snapshot().steps.map(s => s.phase)).toEqual(['collect', 'collect'])
    expect(snapshot().responsibilities[0].noProgress).toBe(0)
    expect(snapshot().responsibilities[0].steps).toBe(2)
    expect(snapshot().notices).toHaveLength(0)
    due(r.id); await manager.reconcile(); await finishCollection('{"release":"failed"}')
    await manager.reconcile()
    expect(snapshot().steps.at(-1)?.phase).toBe('classify')
  })
  it('recovers an interrupted reasoning trial to a proposal without authorizing routine work', async () => {
    const r = propose('Extract source facts.')
    await manager.act(r.id, r.revision, 'trial'); await manager.stop(); sessions.clear()
    manager = new ResponsibilityManager(db, runtime, vi.fn(), collect, inspect, sources)
    manager.start(); await manager.reconcile()
    expect(snapshot().responsibilities[0].state).toBe('blocked')
    await manager.act(r.id, r.revision, 'recover')
    expect(snapshot().responsibilities[0]).toMatchObject({ state: 'proposed', approvedRevision: null, next: null })
    await expect(manager.act(r.id, r.revision, 'approve')).rejects.toThrow('trial')
    await manager.act(r.id, r.revision, 'trial')
    expect(snapshot().steps.at(-1)?.collection?.trial).toBe(true)
  })
  it('stops overdue collection reasoning and keeps the trial unapproved', async () => {
    const r = propose('Extract source facts.'); await manager.act(r.id, r.revision, 'trial')
    const step = snapshot().steps[0]
    db.db.prepare("UPDATE mastermind_steps SET data=json_set(data, '$.createdAt', ?) WHERE id=?").run(new Date(Date.now() - 61000).toISOString(), step.id)
    await manager.reconcile()
    expect(runtime.stopSession).toHaveBeenCalledWith(step.sessionId, false)
    expect(snapshot().responsibilities[0]).toMatchObject({ state: 'blocked', approvedRevision: null, trial: null })
    expect(snapshot().steps[0].state).toBe('held')
    expect(snapshot().notices[0].body).toContain('one-minute limit')
  })
  it('waits for an aborted trial on quit and cannot save a late result', async () => {
    const r = propose()
    let finishRead!: () => void
    collect.mockImplementationOnce((_source, _root, signal) => new Promise<string>(resolve => {
      signal.addEventListener('abort', () => { finishRead = () => resolve('late source') }, { once: true })
    }))
    const trial = manager.act(r.id, r.revision, 'trial')
    const rejected = expect(trial).rejects.toThrow('discarded')
    let stopped = false
    const stopping = manager.stop().then(() => { stopped = true })
    await new Promise(resolve => setTimeout(resolve, 0)); expect(stopped).toBe(false)
    finishRead(); await stopping; await rejected
    expect(snapshot().responsibilities[0].trial).toBeNull()
  })
  it('requires a new successful trial after a failed recheck', async () => {
    const r = propose(); await manager.act(r.id, r.revision, 'trial')
    expect(snapshot().responsibilities[0].trial).not.toBeNull()
    collect.mockRejectedValueOnce(new Error('Source unavailable'))
    await expect(manager.act(r.id, r.revision, 'trial')).rejects.toThrow('Source unavailable')
    expect(snapshot().responsibilities[0].trial).toBeNull()
    await expect(manager.act(r.id, r.revision, 'approve')).rejects.toThrow('trial')
  })
  it('answers a collection question by returning to a source trial, without launching ordinary work', async () => {
    const r = propose('Interpret the supplied source.')
    await manager.act(r.id, r.revision, 'trial')
    await finish(snapshot().steps[0], 'ask', 'Which field matters?')
    const notice = snapshot().notices.find(n => n.kind === 'question')!
    await manager.answer(notice.id, 'The release status.')
    await manager.reconcile()
    expect(snapshot().responsibilities[0]).toMatchObject({ state: 'proposed', next: null })
    expect(runtime.startSession).toHaveBeenCalledTimes(1)
  })
})

describe('Factories through the existing responsibility lifecycle', () => {
  function saveFactory(name = 'PR Review', guide = 'Review, fix valid findings within scope, then independently verify. Ask the engineer at a handoff.') {
    manager.proposeFactory(scope(), { humanInputId: input('Teach this work pattern'), name, diagram: 'graph TD\n A[Review] --> B{Findings?}\n B --> C[Fix]\n C --> D[Verify]', guide })
    const preview = snapshot().factoryProposals![0]
    manager.decideFactory(preview.id, true)
    return snapshot().factories!.find(f => f.name === name)!
  }
  async function advance(action: string, next?: string, extra: Record<string, unknown> = {}) {
    const step = snapshot().steps.filter(s => s.state === 'running').at(-1)!
    expect(step).toBeDefined()
    await manager.report(manager.scopeForToken(manager.tokenForTask(step.taskId)!), { summary: `${step.phase}: ${next ?? action}`, evidence: ['Fixture evidence'], checkout: dir, action, next, ...extra })
    sessions.get(step.taskId)!.session.status = 'idle'
    await manager.reconcile()
    return step
  }

  it('requires exact desktop confirmation and invalidates revised previews; workers cannot mutate guides', async () => {
    const args = { humanInputId: input('Teach PR Review'), name: 'PR Review', diagram: 'review -> done', guide: 'Review within the approved scope.' }
    manager.proposeFactory(scope(), args)
    const old = snapshot().factoryProposals![0]
    expect(snapshot().factories).toEqual([])
    manager.proposeFactory(scope(), { ...args, guide: 'Revised exact instructions.' })
    expect(() => manager.decideFactory(old.id, true)).toThrow('expired')
    manager.decideFactory(snapshot().factoryProposals![0].id, false)
    expect(snapshot().factories).toEqual([])
    const factory = saveFactory()
    expect(factory.guide).toContain('Review, fix')
    expect(factory.provenance).toContain('Engineer confirmed')
    const r = manager.delegate(scope(), input('Review this exact task'), 'Review', undefined, factory.id)
    await manager.reconcile()
    const step = snapshot().steps[0]
    const token = manager.tokenForTask(step.taskId)!
    expect((await callResponsibilityTool(manager, token, 'propose_factory', args)).isError).toBe(true)
    expect((await callResponsibilityTool(manager, token, 'delete_factory', { ...args, factoryId: factory.id })).isError).toBe(true)
    expect(() => manager.proposeFactory(scope(), { ...args, humanInputId: 'external-report' })).toThrow('direct engineer')
    expect(r.agreement.maxSteps).toBe(1)
    await advance('done')
    expect(snapshot().responsibilities[0].state).toBe('completed')
    expect(snapshot().steps).toHaveLength(1)
  })

  it('exposes the Factory proposal and read paths over real scoped HTTP MCP without model approval', async () => {
    setResponsibilityManager(manager)
    const port = await startTaskApiServer(db)
    const token = manager.tokenForTask(projectConversationId(project.id))!
    const client = new Client({ name: 'factory-transport', version: '1' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?responsibility=${token}`)))
      const names = (await client.listTools()).tools.map(t => t.name)
      expect(names).toEqual(expect.arrayContaining(['read_factory', 'propose_factory', 'delete_factory']))
      expect(names).not.toContain('approve_factory')
      const proposed = await client.callTool({ name: 'propose_factory', arguments: { humanInputId: input('Teach a local review guide'), name: 'Transport review', diagram: 'review -> done', guide: 'Read only and report privately.' } })
      expect(proposed.isError).not.toBe(true)
      expect(snapshot().factories).toEqual([])
      const preview = snapshot().factoryProposals![0]
      manager.decideFactory(preview.id, true)
      const catalog = await client.callTool({ name: 'read_factory', arguments: {} })
      expect(JSON.parse((catalog.content as Array<{ text: string }>)[0].text)).toEqual([{ id: preview.definition.id, name: 'Transport review' }])
      const invalid = await client.callTool({ name: 'propose_factory', arguments: { humanInputId: 'worker-result', name: 'Unauthorized', diagram: 'x', guide: 'x' } })
      expect(invalid.isError).toBe(true)
    } finally { await client.close(); stopTaskApiServer(); setResponsibilityManager(undefined) }
  })

  it('runs review, conditional fix and independent verification with approved agents, snapshots and task links', async () => {
    const f = saveFactory()
    const developer = db.createAgent({ name: 'Developer', config: { coding_agent: 'codex', model: 'developer-model', reasoning_effort: 'medium' } })!
    await approve({ ...agreement, factoryId: f.id, allowedAgentIds: [developer.id] })
    const first = snapshot().steps[0]
    expect(first.phase).toBe('coordinate')
    const config = { taskId: first.taskId, agentId: project.agentId, workspaceDir: dir }
    manager.configureSession(config, 1234)
    expect(config).toMatchObject({ responsibilityRole: 'collector', sandboxMode: 'read-only', tools: { bash: false, read: false } })
    await advance('task', 'Review the code')
    const reviewed = await advance('done')
    const coordinator = snapshot().steps.at(-1)!
    await expect(manager.report(manager.scopeForToken(manager.tokenForTask(coordinator.taskId)!), { action: 'task', summary: 'outside profile', evidence: ['none'], checkout: dir, next: 'Fix', agentId: 'unapproved' })).rejects.toThrow('outside the approved')
    await advance('task', 'Fix only the agreed finding', { agentId: developer.id, predecessorTaskIds: [reviewed.taskId] })
    const fixing = snapshot().steps.at(-1)!
    expect(fixing.agent?.id).toBe(developer.id)
    expect(fixing.predecessorTaskIds).toEqual([reviewed.taskId])
    expect(db.getTask(fixing.taskId)?.agent_id).toBe(developer.id)
    manager.proposeFactory(scope(), { humanInputId: input('Delete the saved template'), factoryId: f.id }, 'delete')
    manager.decideFactory(snapshot().factoryProposals![0].id, true)
    expect(snapshot().factories).toEqual([])
    expect(manager.readFactory(manager.scopeForToken(manager.tokenForTask(fixing.taskId)!), f.id)).toMatchObject({ guide: f.guide })
    await advance('done')
    await advance('done')
    expect(snapshot().steps.at(-1)?.phase).toBe('verify')
    expect(snapshot().responsibilities[0].state).toBe('active')
    await advance('done')
    expect(snapshot().responsibilities[0].state).toBe('completed')
    expect(snapshot().steps.map(s => s.phase)).toEqual(['coordinate', 'work', 'coordinate', 'work', 'coordinate', 'verify'])
    expect(snapshot().steps.every(s => s.state === 'settled' && s.factory?.id === f.id)).toBe(true)
    expect(sessions.size).toBe(0)
    expect(new ResponsibilityManager(db, runtime).snapshot().steps[0].factory?.guide).toBe(f.guide)
  })

  it('skips unnecessary work, respects pause, and hands a settled task back for direct pickup', async () => {
    const f = saveFactory()
    const r = await approve({ ...agreement, factoryId: f.id })
    await advance('task', 'Review only')
    const reviewed = await advance('done')
    await manager.act(r.id, r.revision, 'pause')
    await advance('ask', 'Review is ready. Please decide whether any further work is needed.')
    expect(snapshot().steps).toHaveLength(3)
    expect(snapshot().notices.some(n => n.kind === 'question' && n.stepId === snapshot().steps[2].id)).toBe(true)
    await manager.act(r.id, r.revision, 'takeover')
    expect(snapshot().steps.find(s => s.taskId === reviewed.taskId)?.state).toBe('held')
    expect(manager.recordHumanInput(reviewed.taskId, 'I will inspect this task now')).toBeDefined()
    const config = { taskId: reviewed.taskId, agentId: project.agentId, workspaceDir: dir }
    manager.configureSession(config, 1234)
    expect(config).toMatchObject({ systemPrompt: expect.stringContaining('follow-up conversation') })
    expect(sessions.size).toBe(0)
    inspect.mockResolvedValue({ ...evidence(), fingerprint: 'engineer-edited-files' })
    await manager.act(r.id, r.revision, 'handback'); await manager.reconcile()
    await advance('task', 'Inspect the engineer changes before any further work')
    expect(snapshot().steps.at(-1)?.phase).toBe('work')
    expect(snapshot().responsibilities[0].state).toBe('active')
  })

  it('returns worker handoff answers to coordination and verifies the latest changed files without repeating the worker', async () => {
    const f = saveFactory()
    await approve({ ...agreement, factoryId: f.id })
    await advance('task', 'Review')
    await advance('done')
    await advance('task', 'Fix')
    inspect.mockResolvedValue({ ...evidence(), fingerprint: 'corrected-files' })
    await advance('ask', 'Proceed with verification?')
    const question = snapshot().notices.find(n => n.kind === 'question')!
    await manager.answer(question.id, 'Yes, verify the corrected files')
    await manager.reconcile()
    expect(snapshot().steps.at(-1)?.phase).toBe('coordinate')
    await advance('done')
    expect(snapshot().steps.at(-1)?.expectedWork?.fingerprint).toBe('corrected-files')
    await advance('done')
    expect(snapshot().steps.filter(s => s.phase === 'work')).toHaveLength(2)
    expect(snapshot().responsibilities[0].state).toBe('completed')
  })

  it('keeps unrelated Tasks on their normal path and rejects missing/cross-project or changed agent choices', async () => {
    const f = saveFactory()
    expect(() => manager.propose(scope(), { ...agreement, factoryId: 'missing' }, input())).toThrow('Factory not found')
    mkdirSync(join(dir, 'other'))
    const other = manager.createProject('Other', join(dir, 'other'), project.agentId)
    expect(() => manager.factories.read(f.id, other.id)).toThrow('Factory not found')
    const proposed = manager.propose(scope(), { ...agreement, factoryId: f.id }, input())
    db.updateAgent(project.agentId, { config: { coding_agent: 'codex', model: 'changed-model' } })
    await expect(manager.act(proposed.id, proposed.revision, 'approve')).rejects.toThrow('configuration changed')
    const ordinary = manager.delegate(scope(), input('Inspect an unrelated file'), 'Unrelated')
    expect(ordinary.agreement.factory).toBeUndefined()
    await manager.reconcile()
    expect(snapshot().steps.at(-1)?.phase).toBe('work')
  })

  it('lets a Routine classifier select a current guide and keeps the selected snapshot through deletion', async () => {
    const f = saveFactory()
    const r = await approve({ ...agreement, kind: 'routine', schedule: '* * * * *' })
    // Use a deterministic fixture event; no live source state is touched.
    db.db.prepare("UPDATE mastermind_agreements SET data=json_set(data, '$.next', json(?)) WHERE id=?").run(JSON.stringify({ phase: 'classify', instruction: 'A review is needed' }), r.id)
    await manager.reconcile()
    await advance('task', 'Review the changed project', { factoryId: f.id })
    manager.proposeFactory(scope(), { humanInputId: input('Delete this template'), factoryId: f.id }, 'delete')
    manager.decideFactory(snapshot().factoryProposals![0].id, true)
    await advance('task', 'Review evidence')
    await advance('done')
    await advance('done')
    await advance('done')
    const current = snapshot().responsibilities[0]
    expect(current.state).toBe('active')
    expect(current.next).toBeNull()
    expect(current.eventFactory).toBeUndefined()
    expect(snapshot().steps.filter(s => s.phase === 'work')).toHaveLength(1)
  })

  it('fences a live interrupted Factory launch on restart without creating a replacement', async () => {
    const f = saveFactory()
    await approve({ ...agreement, factoryId: f.id })
    expect(snapshot().steps[0].state).toBe('running')
    await manager.stop()
    const reopened = new ResponsibilityManager(db, runtime)
    reopened.start(); await reopened.reconcile()
    expect(reopened.snapshot().steps[0].state).toBe('unknown')
    expect(reopened.snapshot().responsibilities[0].state).toBe('blocked')
    expect(runtime.startSession).toHaveBeenCalledTimes(1)
    await reopened.stop()
  })

  it('bounds progress and does not relaunch interrupted Factory work on reopening', async () => {
    const f = saveFactory()
    await approve({ ...agreement, factoryId: f.id, maxSteps: 2 })
    await advance('task', 'Review within the budget')
    await advance('done')
    expect(snapshot().responsibilities[0].state).toBe('blocked')
    expect(snapshot().steps).toHaveLength(2)
    expect(snapshot().notices.some(n => n.body.includes('step, or no-progress limit'))).toBe(true)
    await manager.stop()
    const reopened = new ResponsibilityManager(db, runtime)
    reopened.start(); await reopened.reconcile(); await reopened.stop()
    expect(snapshot().steps).toHaveLength(2)
  })
})

describe('configured worker access and recurring setup', () => {
  it('captures access from settings, ignores supplied grants, and retains legacy restrictions', async () => {
    db.updateAgent(project.agentId, { config: { ...db.getAgent(project.agentId)!.config, permission_mode: 'allow', sandbox_mode: 'danger-full-access' } })
    const r = await approve({ ...agreement, mode: 'read', access: { permissionMode: 'ask', sandboxMode: 'read-only' } })
    const step = snapshot().steps[0]
    const config = { taskId: step.taskId, agentId: project.agentId, workspaceDir: dir }
    manager.configureSession(config, 1234)
    expect(config).toMatchObject({ permissionMode: 'allow', sandboxMode: 'danger-full-access', responsibilityAccess: true })
    db.updateAgent(project.agentId, { config: { ...db.getAgent(project.agentId)!.config, permission_mode: 'ask', sandbox_mode: 'read-only' } })
    manager.configureSession(config, 1234)
    expect(config).toMatchObject({ permissionMode: 'allow', sandboxMode: 'danger-full-access' })
    db.db.prepare("UPDATE mastermind_agreements SET data=json_remove(data, '$.agreement.access') WHERE id=?").run(r.id)
    manager.configureSession(config, 1234)
    expect(config).toMatchObject({ permissionMode: 'ask', sandboxMode: 'read-only', responsibilityAccess: false })
    const root = { taskId: projectConversationId(project.id), agentId: project.agentId, workspaceDir: dir }
    manager.configureSession(root, 1234)
    expect(root).toMatchObject({ responsibilityRole: 'root', permissionMode: 'ask', sandboxMode: 'read-only', tools: { bash: false } })
  })

  it('requires a fresh preview when agent access changes before approval', async () => {
    const r = manager.propose(scope(), agreement, input())
    db.updateAgent(project.agentId, { config: { ...db.getAgent(project.agentId)!.config, sandbox_mode: 'danger-full-access' } })
    await expect(manager.act(r.id, r.revision, 'approve')).rejects.toThrow('access changed')
  })

  it('keeps full-access settings out of classification permission callbacks', async () => {
    db.updateAgent(project.agentId, { config: { ...db.getAgent(project.agentId)!.config, permission_mode: 'allow', sandbox_mode: 'danger-full-access' } })
    const r = manager.propose(scope(), { ...agreement, kind: 'routine', schedule: '* * * * *', source: { command: 'read-fixture', args: [], description: 'Read evidence' } }, input())
    await manager.act(r.id, r.revision, 'trial'); await manager.act(r.id, r.revision, 'approve'); await manager.reconcile()
    collect.mockResolvedValue('changed evidence')
    db.db.prepare("UPDATE mastermind_agreements SET data=json_set(data, '$.nextAt', ?) WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), r.id)
    await manager.reconcile()
    const step = snapshot().steps[0]
    expect(step.phase).toBe('classify')
    const config: import('./adapters/coding-agent-adapter').SessionConfig = { taskId: step.taskId, agentId: project.agentId, workspaceDir: dir }
    manager.configureSession(config, 1234)
    expect(config).toMatchObject({ permissionMode: 'ask', sandboxMode: 'read-only', responsibilityAccess: false })
    const abort = new AbortController()
    const answer = config.authorizeTool!('Bash', { command: 'external action' }, 'classification-tool', abort.signal)
    expect(snapshot().notices.some(n => n.kind === 'permission' && n.state === 'pending')).toBe(true)
    abort.abort(); expect(await answer).toBe(false)
  })

  it('retains recurring intent through preparation and a restricted setup step to an inactive proposal', async () => {
    const human = input('Inspect the workspace and monitor every ten minutes until the evidence proves success')
    const root = manager.tokenForTask(projectConversationId(project.id))!
    expect((await callResponsibilityTool(manager, root, 'prepare_routine', { humanInputId: human, title: 'Prepare recurring verification' })).isError).not.toBe(true)
    await manager.reconcile()
    const prep = snapshot().responsibilities[0]
    const work = snapshot().steps[0]
    expect(prep).toMatchObject({ routineSetup: {}, agreement: { maxSteps: 2 }, nextAt: null })
    expect((await callResponsibilityTool(manager, manager.tokenForTask(work.taskId)!, 'propose_responsibility', { agreement, humanInputId: human })).isError).toBe(true)
    await finish(work)
    const setup = snapshot().steps.at(-1)!
    expect(setup.phase).toBe('setup')
    const config = { taskId: setup.taskId, agentId: project.agentId, workspaceDir: dir }
    manager.configureSession(config, 1234)
    expect(config).toMatchObject({ responsibilityRole: 'collector', tools: { bash: false, read: false }, responsibilityAccess: false })
    const token = manager.tokenForTask(setup.taskId)!
    const candidate = { ...agreement, basedOn: prep.id, kind: 'routine', schedule: '*/10 * * * *', stopOnSuccess: true, source: { command: 'read-fixture', args: [], description: 'Read approved evidence' } }
    expect((await callResponsibilityTool(manager, token, 'propose_responsibility', { agreement: candidate, humanInputId: input('Different human request') })).isError).toBe(true)
    expect((await callResponsibilityTool(manager, token, 'propose_responsibility', { agreement: candidate, humanInputId: human })).isError).not.toBe(true)
    await finish(setup)
    const routine = snapshot().responsibilities.find(r => r.agreement.kind === 'routine')!
    expect(snapshot().responsibilities.find(r => r.id === prep.id)).toMatchObject({ state: 'completed', routineSetup: { proposalId: routine.id } })
    expect(routine).toMatchObject({ preparedFrom: prep.id, state: 'proposed', nextAt: null, agreement: { schedule: '*/10 * * * *', stopOnSuccess: true } })
    expect(collect).not.toHaveBeenCalled()
    await expect(manager.act(routine.id, routine.revision, 'approve')).rejects.toThrow('trial')
    await manager.act(routine.id, routine.revision, 'trial')
    await manager.act(routine.id, routine.revision, 'approve')
    expect(snapshot().responsibilities.find(r => r.id === routine.id)).toMatchObject({ state: 'active', nextAt: expect.any(String) })
  })

  it('shows failed permission delivery without accepting a replacement request', async () => {
    await approve(); const step = snapshot().steps[0]; const live = sessions.get(step.taskId)!
    live.session.status = 'waiting_approval'
    manager.observe('agent:approval', { taskId: step.taskId, sessionId: live.sessionId, requestId: '1', description: 'Read source' })
    vi.mocked(runtime.respondToPermission).mockRejectedValueOnce(new Error('Codex did not confirm approval'))
    const n = snapshot().notices[0]
    await expect(manager.answer(n.id, 'Approved', true)).rejects.toThrow('did not confirm')
    expect(snapshot().notices.find(v => v.id === n.id)).toMatchObject({ state: 'expired', deliveryError: 'Codex did not confirm approval' })
    await expect(manager.answer(n.id, 'Approved', true)).rejects.toThrow('expired')
  })
})

describe('Routine verified completion', () => {
  async function create(stopOnSuccess = true) {
    const r = manager.propose(scope(), { ...agreement, kind: 'routine', mode: 'read', schedule: '*/10 * * * *', stopOnSuccess, source: { command: 'read-fixture', args: [], description: 'Evidence' } }, input('Monitor until success'))
    await manager.act(r.id, r.revision, 'trial'); await manager.act(r.id, r.revision, 'approve')
    return r
  }
  const due = (id: string) => db.db.prepare("UPDATE mastermind_agreements SET data=json_set(data, '$.nextAt', ?) WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), id)

  it('checks twice without overlapping, verifies success, and never schedules a third check', async () => {
    collect.mockResolvedValue('{"persisted":false}')
    const r = await create(); due(r.id); await manager.reconcile()
    await finish(snapshot().steps.at(-1)!, 'notify')
    collect.mockResolvedValue('{"persisted":true}'); due(r.id); await manager.reconcile()
    const check = snapshot().steps.at(-1)!
    const config: import('./adapters/coding-agent-adapter').SessionConfig = { taskId: check.taskId, agentId: project.agentId, workspaceDir: dir }
    manager.configureSession(config, 1234)
    expect(config.systemPrompt).toContain(`"currentSourceSnapshot":${JSON.stringify(check.instruction)}`)
    expect(config.systemPrompt).toContain(snapshot().steps[0].taskId)
    expect(config.systemPrompt).not.toContain(snapshot().steps[0].report!.summary)
    const calls = collect.mock.calls.length
    due(r.id); await manager.reconcile(); expect(collect).toHaveBeenCalledTimes(calls)
    await finish(check, 'complete')
    const verify = snapshot().steps.at(-1)!
    expect(verify).toMatchObject({ phase: 'verify', completeRoutine: true })
    expect(snapshot().responsibilities[0].state).toBe('active')
    await finish(verify)
    expect(snapshot().responsibilities[0]).toMatchObject({ state: 'completed', nextAt: null, next: null })
    due(r.id); await manager.reconcile(); expect(collect).toHaveBeenCalledTimes(calls)
    expect(snapshot().notices.at(-1)?.body).toContain('No further checks')
  })

  it('continues monitoring after unsuccessful verification, and blocks on missing access', async () => {
    const r = await create(); due(r.id); await manager.reconcile()
    await finish(snapshot().steps.at(-1)!, 'complete')
    await finish(snapshot().steps.at(-1)!, 'continue', 'No matching row has been observed yet')
    expect(snapshot().responsibilities[0]).toMatchObject({ state: 'active', next: null })
    collect.mockRejectedValueOnce(new Error('Tunnel unavailable')); due(r.id); await manager.reconcile()
    expect(snapshot().responsibilities[0].state).toBe('blocked')
  })

  it('requires explicit completion authority and preserves it through an answered verification question', async () => {
    const r = await create(false); collect.mockResolvedValue('changed'); due(r.id); await manager.reconcile()
    await expect(finish(snapshot().steps.at(-1)!, 'complete')).rejects.toThrow('not valid')
    await finish(snapshot().steps.at(-1)!, 'notify')
    await manager.act(r.id, r.revision, 'pause')
    const revised = manager.propose(scope(), { ...snapshot().responsibilities[0].agreement, stopOnSuccess: true }, input('Stop after verified success'), r.id)
    await manager.act(r.id, revised.revision, 'trial'); await manager.act(r.id, revised.revision, 'approve')
    await manager.reconcile(); due(r.id); await manager.reconcile(); await finish(snapshot().steps.at(-1)!, 'complete')
    await finish(snapshot().steps.at(-1)!, 'ask', 'Clarify the observed evidence')
    await manager.answer(snapshot().notices.find(n => n.kind === 'question')!.id, 'Verify the supplied evidence only')
    await manager.reconcile()
    expect(snapshot().steps.at(-1)).toMatchObject({ phase: 'verify', completeRoutine: true })
    await finish(snapshot().steps.at(-1)!)
    expect(snapshot().responsibilities[0].state).toBe('completed')
  })
})
