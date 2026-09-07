import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { ResponsibilityManager, captureWork, collectSource } from './responsibility-manager'
import { projectConversationId } from '../shared/responsibilities'
import type { ResponsibilityAgreement, ResponsibilityStep, WorkEvidence } from '../shared/responsibilities'
import type { AgentManager } from './agent-manager'
import { callResponsibilityTool } from './responsibility-tools'
import { TaskControl } from './task-control'
import { RoutineSources } from './routine-sources'

let dir: string
let manager: ResponsibilityManager
let db: ReturnType<typeof createTestDb>['db']
let project: ReturnType<ResponsibilityManager['createProject']>
let sessions: Map<string, { sessionId: string; session: { workspaceDir: string; status: string } }>
let runtime: Pick<AgentManager, 'startSession' | 'stopSession' | 'findSessionByTaskId' | 'getSessionStatus' | 'respondToPermission'>
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
    respondToPermission: vi.fn(async () => {})
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

describe('durable engineering responsibilities', () => {
  it('lets the project root delete a task without delegation or replacement work', async () => {
    await approve()
    const step = snapshot().steps[0]
    const token = manager.tokenForTask(step.taskId)!
    const confirm = vi.fn(async () => true)
    const service = new TaskControl(db, { withStoppedTasks: async (_ids, action, beforeStop) => { await beforeStop?.(); return action() } }, { completeTask: vi.fn() }, manager, confirm, vi.fn())
    manager.setTaskControl(service)
    vi.spyOn(db, 'deleteTaskAttachments').mockImplementation(() => {})
    expect((await callResponsibilityTool(manager, token, 'manage_task', { task_id: step.taskId, action: 'delete' })).isError).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    const root = manager.tokenForTask(projectConversationId(project.id))!
    const inspected = await callResponsibilityTool(manager, root, 'inspect_tasks', { task_id: step.taskId })
    expect(JSON.stringify(inspected)).toContain(step.taskId)
    const result = await callResponsibilityTool(manager, root, 'manage_task', { task_id: step.taskId, action: 'delete' })
    expect(result.isError).not.toBe(true)
    expect(db.getTask(step.taskId)).toBeUndefined()
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
    expect(config.systemPrompt).toContain('direct control')
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

  it('fences ordinary resume and direct input until takeover and preserves the selected provider', async () => {
    const r = await approve(); const step = snapshot().steps[0]
    expect(() => manager.assertHumanAccess(step.taskId)).toThrow('Take over')
    expect(() => manager.assertLaunch(step.taskId, dir)).toThrow('not authorized')
    await manager.act(r.id, r.revision, 'takeover')
    expect(() => manager.assertHumanAccess(step.taskId)).not.toThrow()
    expect(() => manager.assertLaunch(step.taskId, dir)).not.toThrow()
  })

  it('serializes conflicting work and never shares another project permission', async () => {
    const first = await approve()
    const other = manager.propose(scope(), { ...agreement, title: 'Other goal' }, input('Do another change'))
    await manager.act(other.id, other.revision, 'approve'); await manager.reconcile()
    expect(runtime.startSession).toHaveBeenCalledTimes(1)
    const elsewhere = join(dir, 'other'); mkdirSync(elsewhere)
    const p = manager.createProject('Other project', elsewhere, project.agentId)
    const otherScope = manager.scopeForToken(manager.tokenForTask(projectConversationId(p.id))!)
    expect(() => manager.propose(otherScope, { ...agreement, basedOn: first.id }, input())).toThrow('recorded human')
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
