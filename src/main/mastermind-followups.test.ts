import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { ResponsibilityManager } from './responsibility-manager'
import { projectConversationId } from '../shared/responsibilities'
import { callResponsibilityTool, responsibilityTools } from './responsibility-tools'
import type { AgentManager } from './agent-manager'

let db: ReturnType<typeof createTestDb>['db'], manager: ResponsibilityManager, dir: string
let project: ReturnType<ResponsibilityManager['createProject']>, runtime: ConstructorParameters<typeof ResponsibilityManager>[1]
let live: Map<string, { sessionId: string; session: { agentId: string; status: string; lastActivityAt: number } }>
const rootId = () => projectConversationId(project.id)
const root = () => manager.scopeForToken(manager.tokenForTask(rootId())!)
const snapshot = () => manager.snapshot(project.id)
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await manager.reconcile(); await new Promise(resolve => setImmediate(resolve)) }
const events = () => (db.db.prepare('SELECT data FROM mastermind_followup_events').all() as { data: string }[]).map(r => JSON.parse(r.data))
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), '20x-followups-')); ({ db } = createTestDb())
  db.getWorkspaceDir = id => { const path = join(dir, id); mkdirSync(path, { recursive: true }); return path }
  const agent = db.createAgent({ name: 'Chosen Mastermind', config: { coding_agent: 'codex' } })!
  live = new Map()
  runtime = {
    startSession: vi.fn(async (_a, id) => { live.set(id, { sessionId: `session-${id}`, session: { agentId: agent.id, status: 'working', lastActivityAt: Date.now() } }); return `session-${id}` }),
    stopSession: vi.fn(async id => { for (const [key, value] of live) if (value.sessionId === id) live.delete(key) }),
    findSessionByTaskId: vi.fn(id => live.get(id)) as unknown as AgentManager['findSessionByTaskId'],
    getSessionStatus: vi.fn(id => { for (const [taskId, value] of live) if (value.sessionId === id) return { taskId, agentId: agent.id, status: value.session.status }; return null }),
    respondToPermission: vi.fn(async () => {}), sendByTaskId: vi.fn(async () => ({ sessionId: 'same-worker' })),
    sendMastermindTaskNudge: vi.fn(async (_id, _message, check) => { check() }),
    sendMastermindFollowup: vi.fn(async (id, agentId, _prompt, accepted) => { live.set(id, { sessionId: `review-${id}`, session: { agentId, status: 'working', lastActivityAt: Date.now() } }); accepted(`review-${id}`) }),
    publishMastermindFollowup: vi.fn((id, deliveryId, message) => { db.upsertTranscriptParts(id, [{ id: `followup:${deliveryId}`, role: 'assistant', content: message, partType: 'text' }]) })
  }
  manager = new ResponsibilityManager(db, runtime, vi.fn(), vi.fn(async () => 'unchanged'), vi.fn(async () => ({ checkout: dir, revision: 'abc', fingerprint: 'same' })))
  project = manager.createProject('Project', dir, agent.id); manager.start(); await manager.reconcile()
})
afterEach(async () => { await manager.stop(); db.db.close(); rmSync(dir, { recursive: true, force: true }) })
async function task(action = 'done') {
  const input = manager.recordHumanInput(rootId(), 'Inspect this local fixture, read only.')!
  const r = manager.delegate(root(), input.id, 'Inspect fixture'); await manager.reconcile()
  const step = snapshot().steps.find(s => s.responsibilityId === r.id)!
  if (action !== 'running') {
    await manager.report(manager.scopeForToken(manager.tokenForTask(step.taskId)!), { summary: 'Checked the fixture', evidence: ['local evidence'], checkout: dir, action, ...(action === 'ask' ? { next: 'Question: Which environment?\nWhy: Two choices.\nReply: Staging or production.' } : {}) })
    live.get(step.taskId)!.session.status = 'idle'; await flush()
  }
  return step
}
function finish(text = 'The check finished. Review its result.') {
  const scope = root(), review = manager.followups.context(scope.followupId!) as { events: { id: string }[] }
  return manager.followups.finish(scope.followupId!, review.events.map(e => ({ eventId: e.id, text })), [])
}

describe('proactive Mastermind follow-up', () => {
  it('publishes a result into the same project conversation once, using the selected Mastermind agent', async () => {
    const agent = db.createAgent({ name: 'Selected', config: { coding_agent: 'codex' } })!
    db.setSetting(`mastermind_agent:${rootId()}`, agent.id)
    const step = await task()
    expect(runtime.sendMastermindFollowup).toHaveBeenCalledWith(rootId(), agent.id, expect.any(String), expect.any(Function))
    expect(responsibilityTools(root()).map(t => t.name)).toEqual(['responsibility_context', 'read_responsibility_result', 'finish_followup', 'send_message'])
    expect(finish()).toEqual({ published: true })
    expect(db.getTranscriptParts(rootId())[0].content).toContain(`#20x-task=${step.taskId}`)
    live.get(rootId())!.session.status = 'idle'; await flush(); await flush()
    expect(runtime.sendMastermindFollowup).toHaveBeenCalledTimes(1)
    expect(runtime.publishMastermindFollowup).toHaveBeenCalledTimes(1)
    expect(snapshot().responsibilities[0].state).toBe('completed')
  })
  it('waits for a human turn, and human input supersedes a review without losing queued updates', async () => {
    live.set(rootId(), { sessionId: 'human-session', session: { agentId: project.agentId, status: 'working', lastActivityAt: Date.now() } })
    await task(); expect(runtime.sendMastermindFollowup).not.toHaveBeenCalled()
    live.get(rootId())!.session.status = 'idle'; await flush()
    const scope = root()
    manager.recordHumanInput(rootId(), 'Please address my new question first.')
    await manager.prepareTaskMessage(rootId())
    expect(() => manager.followups.finish(scope.followupId!, [], [])).toThrow('no longer current')
    expect(runtime.publishMastermindFollowup).not.toHaveBeenCalled()
    expect(events()[0].state).toBe('pending')
    expect(live.has(rootId())).toBe(false)
  })
  it('pauses reviews without pausing work, then resumes pending updates', async () => {
    await manager.followups.setEnabled(project.id, false)
    await task(); expect(snapshot().responsibilities[0].state).toBe('completed')
    expect(runtime.sendMastermindFollowup).not.toHaveBeenCalled()
    await manager.followups.setEnabled(project.id, true); await flush()
    expect(runtime.sendMastermindFollowup).toHaveBeenCalledTimes(1)
  })
  it('does not repeat a quiet task nudge or use background review to expand authority', async () => {
    const step = await task('running')
    live.get(step.taskId)!.session.lastActivityAt = Date.now() - 600001
    await flush()
    const token = manager.tokenForTask(rootId())!
    const denied = await callResponsibilityTool(manager, token, 'delegate_responsibility', { humanInputId: 'old', title: 'New work' })
    expect(denied.isError).toBe(true)
    expect((await callResponsibilityTool(manager, token, 'send_message', { task_id: step.taskId, text: 'Any status update?' })).isError).not.toBe(true)
    expect((await callResponsibilityTool(manager, token, 'send_message', { task_id: step.taskId, text: 'Checking again' })).isError).toBe(true)
    const scope = root(), e = events()[0]
    manager.followups.finish(scope.followupId!, [], [e.id])
    live.get(rootId())!.session.status = 'idle'; await flush(); await flush()
    expect(runtime.sendMastermindTaskNudge).toHaveBeenCalledTimes(1)
    expect(runtime.sendMastermindFollowup).toHaveBeenCalledTimes(1)
  })
  it('keeps uncertain delivery visible across restart and requires explicit retry', async () => {
    vi.mocked(runtime.sendMastermindFollowup!).mockRejectedValueOnce(new Error('Transport lost after send'))
    await task(); await flush()
    expect(snapshot().followups![project.id].error).toContain('uncertain')
    await manager.stop()
    manager = new ResponsibilityManager(db, runtime); manager.start(); await flush()
    expect(runtime.sendMastermindFollowup).toHaveBeenCalledTimes(1)
    await manager.followups.retry(project.id)
    // Cooldown remains even after explicit retry.
    db.db.prepare("UPDATE mastermind_followup_reviews SET data=json_set(data,'$.startedAt','2020-01-01')").run()
    await flush(); expect(runtime.sendMastermindFollowup).toHaveBeenCalledTimes(2)
  })
  it('cancels a prepared task nudge when a human interrupts before provider delivery', async () => {
    const step = await task('running')
    live.get(step.taskId)!.session.lastActivityAt = Date.now() - 600001
    await flush()
    let deliver!: () => void
    vi.mocked(runtime.sendMastermindTaskNudge!).mockImplementationOnce((_id, _message, check) => new Promise((resolve, reject) => {
      deliver = () => { try { check(); resolve() } catch (error) { reject(error) } }
    }))
    const sending = manager.messageTask(root(), { task_id: step.taskId, text: 'Any progress?' })
    manager.recordHumanInput(rootId(), 'Please handle my message first.')
    deliver()
    await expect(sending).rejects.toThrow('no longer current')
    expect(runtime.sendByTaskId).not.toHaveBeenCalled()
  })
  it('does not publish a question that was already answered during review', async () => {
    await task('ask')
    const notice = snapshot().notices.find(n => n.kind === 'question')!
    await manager.answer(notice.id, 'Staging')
    expect(finish('Which environment?')).toEqual({ published: false })
    expect(runtime.publishMastermindFollowup).not.toHaveBeenCalled()
  })
  it('times out an unaccepted provider send and releases it before waiting for that send', async () => {
    let rejectSend!: (error: Error) => void
    vi.mocked(runtime.sendMastermindFollowup!).mockImplementationOnce((id, agentId, _prompt, beforeSend) => new Promise((_resolve, reject) => {
      live.set(id, { sessionId: 'stalled-send', session: { agentId, status: 'working', lastActivityAt: Date.now() } })
      beforeSend('stalled-send'); rejectSend = reject
    }))
    await task()
    vi.mocked(runtime.stopSession).mockImplementationOnce(async id => { expect(id).toBe('stalled-send'); live.delete(rootId()); rejectSend(new Error('Session stopped')) })
    const review = manager.followups.reviewFor(rootId())!
    review.startedAt = '2020-01-01'
    await flush()
    expect(snapshot().followups![project.id]).toMatchObject({ reviewing: false, pending: 0 })
    expect(snapshot().followups![project.id].error).toBeTruthy()
    expect(live.has(rootId())).toBe(false)
  })

  it('retries failed cleanup without replaying a published update', async () => {
    await task(); finish()
    vi.mocked(runtime.stopSession).mockRejectedValueOnce(new Error('Process exit not confirmed'))
    live.get(rootId())!.session.status = 'idle'; await flush()
    expect(snapshot().followups![project.id].error).toContain('cleanup failed')
    await manager.followups.retry(project.id); await flush()
    expect(snapshot().followups![project.id].error).toBeUndefined()
    expect(live.has(rootId())).toBe(false)
    expect(runtime.publishMastermindFollowup).toHaveBeenCalledTimes(1)
    expect(runtime.sendMastermindFollowup).toHaveBeenCalledTimes(1)
  })
  it('routes only a current direct human clarification to the exact project question', async () => {
    await manager.followups.setEnabled(project.id, false); await task('ask')
    const notice = snapshot().notices.find(n => n.kind === 'question')!
    const input = manager.recordHumanInput(rootId(), 'Staging')!
    await expect(manager.answerFromConversation(root(), notice.id, 'invented')).rejects.toThrow('latest direct engineer')
    await expect(manager.answerFromConversation(root(), notice.id, input.id)).resolves.toEqual({ answered: true })
    expect(snapshot().notices.find(n => n.id === notice.id)?.answer).toBe('Staging')
  })
  it('keeps project results separate and never wakes on unchanged state', async () => {
    await flush(); expect(runtime.sendMastermindFollowup).not.toHaveBeenCalled()
    const otherPath = join(dir, 'other'); mkdirSync(otherPath)
    const other = manager.createProject('Other', otherPath, project.agentId)
    await task(); finish()
    expect(db.getTranscriptParts(projectConversationId(other.id))).toHaveLength(0)
    expect(runtime.sendMastermindFollowup).toHaveBeenCalledTimes(1)
  })
  it('drops a background launch overtaken by human input before provider acceptance', async () => {
    let accept!: () => void
    vi.mocked(runtime.sendMastermindFollowup!).mockImplementationOnce((id, agentId, _prompt, beforeSend) => new Promise((resolve, reject) => {
      live.set(id, { sessionId: 'opening-review', session: { agentId, status: 'idle', lastActivityAt: Date.now() } })
      accept = () => { try { beforeSend('opening-review'); resolve() } catch (error) { reject(error) } }
    }))
    await task()
    manager.recordHumanInput(rootId(), 'New human question')
    const waiting = manager.prepareTaskMessage(rootId())
    accept(); await waiting
    expect(runtime.publishMastermindFollowup).not.toHaveBeenCalled()
    expect(live.has(rootId())).toBe(false)
    expect(events()[0].state).toBe('pending')
  })
  it('keeps required results pending if a reviewer tries to omit or silence them', async () => {
    await task(); const id = root().followupId!
    expect(() => manager.followups.finish(id, [], [])).toThrow('every queued event')
    expect(() => manager.followups.finish(id, [], [events()[0].id])).toThrow('must reach')
    expect(events()[0].state).toBe('reviewing')
    expect(runtime.publishMastermindFollowup).not.toHaveBeenCalled()
  })
  it('detects the deadline of a still-running task without restarting or completing it', async () => {
    const step = await task('running')
    db.db.prepare("UPDATE mastermind_agreements SET data=json_set(data,'$.agreement.deadline','2020-01-01') WHERE id=?").run(step.responsibilityId)
    await flush()
    expect(events()[0].kind).toBe('deadline')
    finish('The deadline passed. Review the unfinished task.')
    expect(snapshot().steps[0].state).toBe('running')
    expect(runtime.startSession).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('keeps deterministic routine checks model-free (source: %s)', async source => {
    const input = manager.recordHumanInput(rootId(), 'Check each minute.')!
    const work = manager.propose(root(), { kind: 'routine', title: 'Check status', objective: 'Watch the local status', scope: 'Local reads', finish: 'Report changes', stop: 'No writes', mode: 'read', priority: 'medium', agentId: project.agentId, maxSteps: 5, deadline: new Date(Date.now() + 86400000).toISOString(), schedule: '* * * * *', ...(source ? { source: { command: 'git', args: ['status'], description: 'Read status' } } : {}) }, input.id)
    if (source) await manager.act(work.id, work.revision, 'trial')
    await manager.act(work.id, work.revision, 'approve')
    db.db.prepare("UPDATE mastermind_agreements SET data=json_set(data,'$.nextAt','2020-01-01') WHERE id=?").run(work.id)
    await flush()
    expect(runtime.startSession).not.toHaveBeenCalled()
    expect(runtime.sendMastermindFollowup).not.toHaveBeenCalled()
    expect(runtime.publishMastermindFollowup).toHaveBeenCalledTimes(source ? 0 : 1)
  })

})

it('drops a deleted task question during review and never retries the obsolete event', async () => {
  const step = await task('ask')
  db.deleteTask(step.taskId)
  expect(finish('Please choose an environment.')).toEqual({ published: false })
  expect(runtime.publishMastermindFollowup).not.toHaveBeenCalled()
  expect(events().every(e => e.state === 'superseded')).toBe(true)
  live.get(rootId())!.session.status = 'idle'; await flush()
  await manager.followups.retry(project.id); await flush()
  expect(runtime.publishMastermindFollowup).not.toHaveBeenCalled()
  expect(snapshot().followups?.[project.id].pending).toBe(0)
})

it('keeps a completed result readable but removes a deleted task link before publication', async () => {
  const step = await task()
  db.deleteTask(step.taskId)
  expect(finish()).toEqual({ published: true })
  const message = db.getTranscriptParts(rootId())[0].content
  expect(message).toContain('Review its result')
  expect(message).not.toContain('#20x-task=')
})

it.each(['quiet', 'deadline'])('rechecks %s observations before nudging or publishing', async kind => {
  const step = await task('running')
  if (kind === 'quiet') live.get(step.taskId)!.session.lastActivityAt = Date.now() - 600001
  else db.db.prepare("UPDATE mastermind_agreements SET data=json_set(data,'$.agreement.deadline','2020-01-01') WHERE id=?").run(step.responsibilityId)
  await flush()
  expect(events()[0].kind).toBe(kind)
  if (kind === 'quiet') {
    live.get(step.taskId)!.session.lastActivityAt = Date.now()
    expect(() => manager.followups.claimNudge(root().followupId!, step.taskId)).toThrow('quiet, running task')
  } else db.db.prepare("UPDATE mastermind_agreements SET data=json_set(data,'$.agreement.deadline','2030-01-01') WHERE id=?").run(step.responsibilityId)
  expect(finish('This task needs attention.')).toEqual({ published: false })
  expect(runtime.publishMastermindFollowup).not.toHaveBeenCalled()
})
