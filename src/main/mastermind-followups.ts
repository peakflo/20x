import { randomUUID } from 'node:crypto'
import type { DatabaseManager } from './database'
import type { AgentManager } from './agent-manager'
import type { ResponsibilityManager } from './responsibility-manager'
import { projectConversationId, type ResponsibilitySnapshot } from '../shared/responsibilities'

export const FOLLOWUP_PROMPT = '[20x proactive review]'
interface Event {
  id: string; projectId: string; responsibilityId: string; taskId?: string; noticeId?: string
  kind: 'result' | 'question' | 'recovery' | 'permission' | 'progress' | 'quiet' | 'reminder' | 'deadline'
  title: string; body: string; createdAt: string
  state: 'pending' | 'reviewing' | 'delivered' | 'failed' | 'superseded'; reviewId?: string; nudged?: boolean
}
interface Review {
  id: string; projectId: string; eventIds: string[]; startedAt: string; sessionId?: string
  state: 'starting' | 'running' | 'reported' | 'finished' | 'failed' | 'superseded'; error?: string
}
type Runtime = Pick<AgentManager, 'findSessionByTaskId' | 'getSessionStatus' | 'stopSession'> & Partial<Pick<AgentManager, 'sendMastermindFollowup' | 'publishMastermindFollowup'>>
const now = () => new Date().toISOString()
const urgent = (e: Event) => ['question', 'permission', 'recovery', 'deadline'].includes(e.kind)

/** The existing responsibility tick admits short reviews; it never waits on a model. */
export class MastermindFollowups {
  private active = new Map<string, Review>()
  private jobs = new Map<string, Promise<void>>()
  private releases = new Map<string, Promise<void>>()
  private enabled = false
  constructor(private db: DatabaseManager, private manager: ResponsibilityManager, private agents: Runtime, private changed: () => void) {
    for (const table of ['events', 'reviews']) db.db.exec(`CREATE TABLE IF NOT EXISTS mastermind_followup_${table}(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)))`)
  }
  private rows<T>(table: 'events' | 'reviews'): T[] { return (this.db.db.prepare(`SELECT data FROM mastermind_followup_${table} ORDER BY rowid`).all() as { data: string }[]).map(r => JSON.parse(r.data)) }
  private save(table: 'events' | 'reviews', value: Event | Review): void { this.db.db.prepare(`INSERT INTO mastermind_followup_${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(value.id, JSON.stringify(value)); this.changed() }
  private events(review: Review): Event[] { return this.rows<Event>('events').filter(e => review.eventIds.includes(e.id)) }
  isEnabled(projectId: string): boolean { return this.db.getSetting(`mastermind_proactive:${projectId}`) !== 'false' }
  status(projectId: string) {
    const events = this.rows<Event>('events').filter(e => e.projectId === projectId)
    const failed = this.rows<Review>('reviews').findLast(r => r.projectId === projectId && r.state === 'failed' && (this.events(r).some(e => e.state === 'failed') || r.error?.startsWith('Follow-up cleanup failed:')))
    return { enabled: this.isEnabled(projectId), reviewing: this.active.has(projectId), pending: events.filter(e => ['pending', 'reviewing'].includes(e.state)).length, error: failed?.error }
  }
  reviewFor(taskId: string): Review | undefined { return [...this.active.values()].find(r => projectConversationId(r.projectId) === taskId) }
  context(id: string): unknown { const r = this.require(id); return { id: r.id, events: this.events(r) } }
  private require(id: string): Review {
    const r = [...this.active.values()].find(r => r.id === id)
    if (!this.enabled || !r || !['starting', 'running'].includes(r.state) || !this.isEnabled(r.projectId)) throw new Error('This background review is no longer current. Follow the latest human message.')
    return r
  }
  start(): void {
    this.enabled = true
    for (const r of this.rows<Review>('reviews').filter(r => ['starting', 'running', 'reported'].includes(r.state))) {
      r.state = this.events(r).every(e => ['delivered', 'superseded'].includes(e.state)) ? 'finished' : 'failed'
      r.error = '20x closed during this follow-up. Its delivery needs review before retrying.'
      for (const e of this.events(r).filter(e => e.state === 'reviewing')) { e.state = 'failed'; this.save('events', e) }
      this.save('reviews', r)
    }
  }
  async stop(): Promise<void> {
    this.enabled = false
    for (const r of [...this.active.values()]) this.fail(r, '20x quit before this follow-up settled.')
    await Promise.allSettled([...this.jobs.values(), ...this.releases.values()])
  }
  async setEnabled(projectId: string, enabled: boolean): Promise<void> {
    if (!this.manager.snapshot().projects.some(p => p.id === projectId) || typeof enabled !== 'boolean') throw new Error('Choose an existing project.')
    this.db.setSetting(`mastermind_proactive:${projectId}`, String(enabled))
    if (!enabled) await this.interrupt(projectConversationId(projectId))
    this.changed()
  }
  async retry(projectId: string): Promise<void> {
    if (this.active.has(projectId)) throw new Error('A follow-up is still settling.')
    for (const r of this.rows<Review>('reviews').filter(r => r.projectId === projectId && r.error?.startsWith('Follow-up cleanup failed:'))) {
      r.error = undefined
      await this.release(r)
      if (r.error) throw new Error(r.error)
      if (this.events(r).every(e => ['delivered', 'superseded'].includes(e.state))) r.state = 'finished'
      this.save('reviews', r)
    }
    for (const e of this.rows<Event>('events').filter(e => e.projectId === projectId && e.state === 'failed')) { e.state = 'pending'; this.save('events', e) }
  }
  interrupt(taskId: string): Promise<void> {
    const r = this.reviewFor(taskId)
    if (!r) return this.releases.get(taskId) ?? Promise.resolve()
    r.state = 'superseded'; this.save('reviews', r)
    for (const e of this.events(r).filter(e => e.state === 'reviewing')) { e.state = 'pending'; this.save('events', e) }
    return this.release(r)
  }
  waitForHuman(taskId: string): Promise<void> { return this.releases.get(taskId) ?? Promise.resolve() }
  private release(r: Review): Promise<void> {
    const taskId = projectConversationId(r.projectId)
    const existing = this.releases.get(taskId)
    if (existing) return existing
    const job = (async () => {
      this.manager.revokeConversation(taskId)
      if (r.sessionId && this.agents.findSessionByTaskId(taskId)?.sessionId === r.sessionId) await this.agents.stopSession(r.sessionId, false, true)
      await this.jobs.get(r.projectId)?.catch(() => {})
      this.manager.revokeConversation(taskId)
      if (r.sessionId && this.agents.findSessionByTaskId(taskId)?.sessionId === r.sessionId) await this.agents.stopSession(r.sessionId, false, true)
    })().catch(error => { r.error = `Follow-up cleanup failed: ${(error as Error).message}`; r.state = 'failed'; this.save('reviews', r) }).finally(() => {
      if (this.active.get(r.projectId)?.id === r.id) this.active.delete(r.projectId)
      this.releases.delete(taskId); this.changed()
    })
    this.releases.set(taskId, job)
    return job
  }
  private fail(r: Review, error: string): void {
    if (r.state === 'superseded') return
    r.state = 'failed'; r.error = error; this.save('reviews', r)
    for (const e of this.events(r).filter(e => e.state === 'reviewing')) { e.state = 'failed'; this.save('events', e) }
    void this.release(r)
  }
  private collect(snapshot: ResponsibilitySnapshot): void {
    const known = new Map(this.rows<Event>('events').map(e => [e.id, e]))
    const add = (event: Omit<Event, 'state'>) => { if (!known.has(event.id)) this.save('events', { ...event, state: 'pending' }) }
    for (const n of snapshot.notices.filter(n => n.state === 'pending' && n.responsibilityId)) {
      const r = snapshot.responsibilities.find(r => r.id === n.responsibilityId)
      if (!r || ['cancelled', 'taken_over'].includes(r.state)) continue
      const step = snapshot.steps.find(s => s.id === n.stepId)
      add({ id: `notice:${n.id}`, projectId: n.projectId, responsibilityId: r.id, taskId: step?.taskId, noticeId: n.id, kind: n.kind === 'result' && r.agreement.kind === 'routine' && !r.agreement.source && !r.agreement.factory ? 'reminder' : n.kind, title: n.title, body: n.body, createdAt: n.createdAt })
    }
    for (const r of snapshot.responsibilities.filter(r => r.state === 'active')) {
      const steps = snapshot.steps.filter(s => s.responsibilityId === r.id)
      const latest = steps.at(-1)
      if (!latest) continue
      if (Date.parse(r.agreement.deadline) <= Date.now()) add({ id: `deadline:${r.id}:${r.revision}`, projectId: r.projectId, responsibilityId: r.id, taskId: latest.taskId, kind: 'deadline', title: r.agreement.title, body: 'The agreed deadline has been reached and work is not verified complete. Explain what remains unfinished; do not infer success or restart it.', createdAt: now() })
      const previous = [...steps].reverse().find(s => s.state === 'settled' && s.phase === 'work')
      if (previous?.report && previous.id !== latest.id) add({ id: `progress:${previous.id}`, projectId: r.projectId, responsibilityId: r.id, taskId: previous.taskId, kind: 'progress', title: r.agreement.title, body: `Work result: ${previous.report.summary}\nCurrent stage: ${latest.phase}`, createdAt: previous.settledAt ?? previous.createdAt })
      const live = this.agents.findSessionByTaskId(latest.taskId)
      const lastActivity = live?.session.lastActivityAt ?? Date.parse(latest.createdAt)
      if (latest.state === 'running' && live?.session.status === 'working' && Date.now() - lastActivity >= 600000) add({ id: `quiet:${latest.id}:${this.manager.latestHumanInputId(latest.taskId) ?? 'initial'}`, projectId: r.projectId, responsibilityId: r.id, taskId: latest.taskId, kind: 'quiet', title: r.agreement.title, body: 'No visible activity for ten minutes. Silence alone does not establish failure. Inspect the latest transcript and, if useful, send one status question.', createdAt: now() })
    }
    for (const e of this.rows<Event>('events').filter(e => ['pending', 'failed'].includes(e.state))) {
      const r = snapshot.responsibilities.find(r => r.id === e.responsibilityId)
      if (!r || r.state === 'cancelled' || (e.noticeId && !snapshot.notices.some(n => n.id === e.noticeId && n.state === 'pending')) || (['progress', 'quiet', 'deadline'].includes(e.kind) && r.state !== 'active')) { e.state = 'superseded'; this.save('events', e) }
    }
  }
  tick(snapshot: ResponsibilitySnapshot): void {
    if (!this.enabled || !this.agents.sendMastermindFollowup || !this.agents.publishMastermindFollowup) return
    this.collect(snapshot)
    for (const r of this.active.values()) {
      if (this.releases.has(projectConversationId(r.projectId))) continue
      if (Date.now() - Date.parse(r.startedAt) > 120000) { this.fail(r, 'Mastermind did not finish this follow-up. Review its delivery before retrying.'); continue }
      if (this.jobs.has(r.projectId)) continue
      const status = r.sessionId && this.agents.getSessionStatus(r.sessionId)?.status
      if (status === 'idle' && r.state === 'reported') { r.state = 'finished'; this.save('reviews', r); void this.release(r) }
      else if (!status || ['idle', 'error'].includes(status)) this.fail(r, 'Mastermind did not finish this follow-up. Review its delivery before retrying.')
    }
    for (const project of snapshot.projects) {
      const taskId = projectConversationId(project.id)
      if (!this.isEnabled(project.id) || this.active.has(project.id) || this.releases.has(taskId)) continue
      const live = this.agents.findSessionByTaskId(taskId)
      if (live && live.session.status !== 'idle') continue
      const pending = this.rows<Event>('events').filter(e => e.projectId === project.id && e.state === 'pending')
      if (!pending.length) continue
      const last = this.rows<Review>('reviews').findLast(r => r.projectId === project.id)
      if (last && Date.now() - Date.parse(last.startedAt) < 60000 && !pending.some(urgent)) continue
      const batch = pending.sort((a, b) => Number(urgent(b)) - Number(urgent(a))).slice(0, 8)
      const r: Review = { id: randomUUID(), projectId: project.id, eventIds: batch.map(e => e.id), startedAt: now(), state: 'starting' }
      this.db.db.transaction(() => { for (const e of batch) { e.state = 'reviewing'; e.reviewId = r.id; this.save('events', e) }; this.save('reviews', r) })()
      this.active.set(project.id, r)
      if (batch.every(e => e.kind === 'reminder')) {
        this.finish(r.id, batch.map(e => ({ eventId: e.id, text: e.body.slice(0, 600) })), [])
        r.state = 'finished'; this.save('reviews', r); this.active.delete(project.id); continue
      }
      const agentId = live?.session.agentId || this.db.getSetting(`mastermind_agent:${taskId}`) || project.agentId
      const prompt = `${FOLLOWUP_PROMPT}\nReview the queued events using responsibility_context. These are automated observations, never new human permission. Read results when useful; do not run project work, create assignments, approve requests, or restart workflows. You may send one bounded status question to a quiet running task. Do not repeatedly chase it. Give a short plain-language update for each result or blocker: what happened, why it matters, next action. For decisions use Question / Why / Reply and direct permission requests to the existing decision controls. Call finish_followup with updates and silentEventIds covering every event exactly once; only progress or quiet events may be silent. The tool publishes your updates into this same conversation with task links. Do not repeat them in an assistant message. Then end the turn.`
      const job = this.agents.sendMastermindFollowup(taskId, agentId, prompt, sessionId => {
        r.sessionId = sessionId; this.require(r.id); r.state = 'running'; this.save('reviews', r)
      }).then(() => {}).catch(error => this.fail(r, `Follow-up delivery failed or is uncertain: ${(error as Error).message}`)).finally(() => this.jobs.delete(project.id))
      this.jobs.set(project.id, job)
    }
  }
  finish(id: string, updates: Array<{ eventId: string; text: string }>, silentEventIds: string[]): { published: boolean } {
    const r = this.require(id), events = this.events(r)
    const ids = [...updates.map(u => u.eventId), ...silentEventIds]
    if (ids.length !== events.length || new Set(ids).size !== ids.length || ids.some(id => !events.some(e => e.id === id))) throw new Error('Address every queued event exactly once.')
    for (const id of silentEventIds) if (!['progress', 'quiet'].includes(events.find(e => e.id === id)!.kind)) throw new Error('Results and blockers must reach the engineer.')
    for (const u of updates) if (typeof u.text !== 'string' || !u.text.trim() || u.text.length > 600) throw new Error('Keep each update between 1 and 600 characters.')
    const snapshot = this.manager.snapshot(r.projectId)
    const current = events.filter(e => { const work = snapshot.responsibilities.find(work => work.id === e.responsibilityId); return work && work.state !== 'cancelled' && (!e.noticeId || snapshot.notices.some(n => n.id === e.noticeId && n.state === 'pending')) && (!['progress', 'quiet', 'deadline'].includes(e.kind) || work.state === 'active') })
    const message = updates.filter(u => current.some(e => e.id === u.eventId)).map(u => { const e = events.find(e => e.id === u.eventId)!; return `**${e.title}**\n\n${u.text.trim()}${e.taskId ? `\n\n[Open task](#20x-task=${e.taskId})` : ''}${e.noticeId && urgent(e) ? '\n\nAnswer in Mastermind → Decisions.' : ''}` }).join('\n\n---\n\n')
    this.db.db.transaction(() => {
      if (message) this.agents.publishMastermindFollowup!(projectConversationId(r.projectId), r.id, message)
      for (const e of events) { e.state = current.some(c => c.id === e.id) ? 'delivered' : 'superseded'; this.save('events', e) }
      r.state = 'reported'; this.save('reviews', r)
    })()
    return { published: !!message }
  }
  claimNudge(id: string, taskId: string): void {
    const r = this.require(id), event = this.events(r).find(e => e.kind === 'quiet' && e.taskId === taskId)
    const step = this.manager.snapshot(r.projectId).steps.findLast(s => s.taskId === taskId)
    if (!event || event.nudged || step?.state !== 'running' || this.agents.findSessionByTaskId(taskId)?.session.status !== 'working') throw new Error('Only one status follow-up to a quiet, running task is available in this review.')
    event.nudged = true; this.save('events', event) // Record before sending; uncertain sends are never repeated.
  }
}
