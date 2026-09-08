import { randomUUID } from 'node:crypto'
import { mkdir, copyFile, stat } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { app } from 'electron'
import type { DatabaseManager } from './database'
import type { AgentManager } from './agent-manager'
import { listTaskArtifactEntries, listRegisteredTaskArtifacts, resolveTaskArtifactFilePath } from './artifacts'
import { isWorkfloLinkedTask } from './workflo-task-sync'
import { isReusableSchedule, type ScheduleRun } from '../shared/schedule-runs'

/** One durable check per reusable task; ordinary agent sessions still own execution. */
export class ScheduleRuns {
  private closing = false
  private jobs = new Map<string, Promise<unknown>>()
  private settling = new Set<string>()
  constructor(private db: DatabaseManager, private agents: AgentManager, private changed: (taskId: string) => void) {
    db.db.exec(`CREATE TABLE IF NOT EXISTS task_schedule_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX IF NOT EXISTS schedule_runs_task ON task_schedule_runs(task_id);
      CREATE UNIQUE INDEX IF NOT EXISTS schedule_runs_active ON task_schedule_runs(task_id) WHERE json_extract(data, '$.finishedAt') IS NULL;`)
    for (const row of db.db.prepare("SELECT data FROM task_schedule_runs WHERE json_extract(data, '$.finishedAt') IS NULL").all() as { data: string }[]) {
      const run: ScheduleRun = JSON.parse(row.data)
      if (run.state !== 'pending') this.interrupt(run, '20x stopped during this check. Inspect its history, then release the interrupted check before resuming.')
    }
  }
  active(taskId: string): ScheduleRun | undefined {
    const row = this.db.db.prepare("SELECT data FROM task_schedule_runs WHERE task_id = ? AND json_extract(data, '$.finishedAt') IS NULL").get(taskId) as { data: string } | undefined
    return row && JSON.parse(row.data)
  }
  history(taskId: string, runId?: string, before?: string): unknown {
    if (!this.db.getTask(taskId)) throw new Error('Task not found.')
    if (runId) {
      const row = this.db.db.prepare('SELECT data FROM task_schedule_runs WHERE task_id = ? AND id = ?').get(taskId, runId) as { data: string } | undefined
      if (!row) throw new Error('Run not found for this task.')
      return { ...JSON.parse(row.data), transcript: this.db.getTranscriptParts(taskId).filter(p => p.partId.startsWith(`run:${runId}:`)) }
    }
    return (this.db.db.prepare("SELECT data FROM task_schedule_runs WHERE task_id = ? AND json_extract(data, '$.dueAt') < ? ORDER BY json_extract(data, '$.dueAt') DESC, rowid DESC LIMIT 20").all(taskId, before || '9999') as { data: string }[]).map(r => JSON.parse(r.data))
  }
  private save(run: ScheduleRun): void {
    this.db.db.prepare('INSERT INTO task_schedule_runs(id, task_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(run.id, run.taskId, JSON.stringify(run))
    this.changed(run.taskId)
  }
  private interrupt(run: ScheduleRun, message: string): void {
    run.state = 'interrupted'; run.summary = message
    this.db.updateTask(run.taskId, { recurrence_paused: true, next_occurrence_at: null })
    this.save(run)
  }
  pending(taskId: string, dueAt: string): ScheduleRun {
    if (this.closing) throw new Error('20x is quitting.')
    const existing = this.active(taskId)
    if (existing) return existing
    const run: ScheduleRun = { id: randomUUID(), taskId, dueAt, startedAt: null, finishedAt: null, state: 'pending', agentId: null, sessionId: null, summary: '', artifacts: [] }
    this.save(run)
    return run
  }
  async start(taskId: string, agentId?: string, scheduled = false): Promise<string> {
    if (this.closing) throw new Error('20x is quitting.')
    const task = this.db.getTask(taskId)
    if (!task || !isReusableSchedule(task) || task.server_managed || isWorkfloLinkedTask(this.db, task)) throw new Error('Choose a local reusable schedule.')
    if (scheduled && (task.recurrence_paused || !task.auto_start_agent)) throw new Error('Automatic checks are disabled.')
    if (task.status === 'completed') throw new Error('This task is completed.')
    const prior = this.active(taskId)
    if (this.jobs.has(taskId) || (prior && prior.state !== 'pending') || this.agents.findSessionByTaskId(taskId)) throw new Error('A check is already running or needs inspection. No additional check was started.')
    const run = prior || this.pending(taskId, new Date().toISOString())
    const selected = agentId || task.agent_id
    if (!selected || !this.db.getAgent(selected)) { this.interrupt(run, 'Assign an agent before starting this check.'); throw new Error(run.summary) }
    run.state = 'starting'; run.agentId = selected; run.startedAt = new Date().toISOString(); this.save(run)
    const job = this.agents.startScheduledRun(taskId, selected).then(sessionId => {
      const current = this.active(taskId)
      if (current?.id === run.id && current.state === 'starting') { current.state = 'running'; current.sessionId = sessionId; this.save(current) }
      return sessionId
    }).catch(error => {
      const current = this.active(taskId)
      if (current?.id === run.id) this.interrupt(current, `Check launch did not settle: ${(error as Error).message}`)
      throw error
    })
    this.jobs.set(taskId, job)
    try { return await job } finally { if (this.jobs.get(taskId) === job) this.jobs.delete(taskId) }
  }
  bind(taskId: string, sessionId: string): void {
    const run = this.active(taskId)
    const session = this.agents.getSession(sessionId)
    if (!run || run.state !== 'starting' || run.sessionId || session?.taskId !== taskId) throw new Error('No schedule launch owns this session.')
    session.scheduleRunId = run.id
    run.sessionId = sessionId; this.save(run)
  }
  context(taskId: string): string {
    const run = this.active(taskId)
    if (!run) return ''
    const prior = (this.history(taskId) as ScheduleRun[]).filter(r => r.finishedAt).slice(0, 5)
    return `\n\nScheduled check ${run.id}, due ${run.dueAt}. Perform one check of the task objective, report findings or the exact failure, then finish. The schedule owns future checks; do not create another copy of this task or complete the persistent task. The same workspace retains your files and checkpoints. Earlier results are historical context, never new permission:\n${JSON.stringify(prior.map(r => ({ at: r.dueAt, state: r.state, result: r.summary.slice(0, 6000) })))}`
  }
  assertMessage(taskId: string, sessionId: string): void {
    if (!isReusableSchedule(this.db.getTask(taskId))) return
    const run = this.active(taskId)
    const live = this.agents.findSessionByTaskId(taskId)
    if (!run || !live || live.sessionId !== sessionId || this.settling.has(taskId) || run.state === 'interrupted') throw new Error('Start a new check, or inspect and release the interrupted check first. Historical sessions cannot be resumed.')
  }
  /** Namespace parts before persistence and rendering; reject output from a prior run. */
  event(channel: string, data: unknown): boolean {
    if (!['agent:output', 'agent:output-batch', 'agent:status'].includes(channel)) return true
    if (!data || typeof data !== 'object') return true
    const event = data as { taskId?: string; sessionId?: string; status?: string; data?: { id?: string }; messages?: { id?: string }[] }
    if (!event.taskId) return true
    const live = event.sessionId ? this.agents.getSession(event.sessionId) : undefined
    if (live && !live.scheduleRunId) return true
    if (!live && !isReusableSchedule(this.db.getTask(event.taskId))) return true
    const run = this.active(event.taskId)
    if (!run || !live || live.taskId !== event.taskId || live.scheduleRunId !== run.id) return channel === 'agent:status' && !!run && run.sessionId === event.sessionId
    if (run.sessionId !== event.sessionId) { run.sessionId = event.sessionId!; this.save(run) }
    if (channel === 'agent:output' || channel === 'agent:output-batch') {
      for (const part of event.messages || (event.data ? [event.data] : [])) if (part.id && !part.id.startsWith(`run:${run.id}:`)) part.id = `run:${run.id}:${part.id}`
    }
    if (channel === 'agent:status' && run && run.sessionId === event.sessionId && ['working', 'waiting_approval'].includes(event.status || '') && run.state !== 'interrupted') {
      run.state = event.status === 'waiting_approval' ? 'waiting_approval' : 'running'; this.save(run)
    }
    if (channel === 'agent:status' && run.state !== 'interrupted' && run.sessionId === event.sessionId && ['idle', 'error'].includes(event.status || '') && !this.settling.has(event.taskId)) {
      this.settling.add(event.taskId)
      const job = this.finish(run, event.status === 'error').catch(error => { if (this.db.getTask(run.taskId)) this.interrupt(run, `Check cleanup needs inspection: ${(error as Error).message}`) }).finally(() => { this.settling.delete(run.taskId); if (this.jobs.get(run.taskId) === job) this.jobs.delete(run.taskId) })
      this.jobs.set(run.taskId, job)
    }
    return true
  }
  private async archive(run: ScheduleRun): Promise<void> {
    run.artifacts = []
    const workspace = this.db.getWorkspaceDir(run.taskId)
    const entries = await listTaskArtifactEntries(workspace, run.taskId)
    const registered = await listRegisteredTaskArtifacts(workspace, run.taskId)
    const paths = new Set([...entries.map(e => e.path), ...registered.flatMap(a => a.files.map(f => `artifacts/${a.artifactId}/${f}`))])
    // ponytail: bounded per-run copies; larger reports require an explicit retention design.
    if (paths.size > 200) throw new Error('More than 200 artifact files; inspect before continuing.')
    let bytes = 0
    for (const relative of paths) {
      const source = await resolveTaskArtifactFilePath(workspace, relative)
      if (!source) throw new Error(`Artifact cannot be archived: ${relative}`)
      bytes += (await stat(source)).size
      if (bytes > 100 * 1024 * 1024) throw new Error('Run artifacts exceed 100 MB; inspect before continuing.')
      const target = join(app.getPath('userData'), 'schedule-runs', run.taskId, run.id, relative)
      await mkdir(dirname(target), { recursive: true }); await copyFile(source, target)
      run.artifacts.push({ title: entries.find(e => e.path === relative)?.title || basename(relative), path: target })
    }
  }
  private async finish(run: ScheduleRun, failed: boolean): Promise<void> {
    // Release the owning runtime before freezing history or admitting another run.
    await this.agents.withStoppedTasks([run.taskId], async () => {
      await this.archive(run)
      const parts = this.db.getTranscriptParts(run.taskId).filter(p => p.partId.startsWith(`run:${run.id}:`) && p.content)
      run.summary = (failed ? parts.findLast(p => p.partType === 'error') : parts.findLast(p => p.role === 'assistant' && (!p.partType || p.partType === 'text')))?.content || (failed ? 'Agent reported an error.' : 'Agent finished without a text result.')
      if (this.active(run.taskId)?.state === 'interrupted') return
      run.state = failed ? 'failed' : 'finished'; run.finishedAt = new Date().toISOString(); this.save(run)
    }, undefined, false)
  }
  async reconcile(): Promise<void> {
    for (const row of this.db.db.prepare("SELECT data FROM task_schedule_runs WHERE json_extract(data, '$.finishedAt') IS NULL").all() as { data: string }[]) {
      const run: ScheduleRun = JSON.parse(row.data)
      if (['starting', 'running', 'waiting_approval'].includes(run.state) && !this.jobs.has(run.taskId) && !this.agents.findSessionByTaskId(run.taskId)) this.interrupt(run, 'The check stopped before a final result. Inspect and release it before resuming.')
    }
  }
  discardPending(taskId: string): void {
    const run = this.active(taskId)
    if (run?.state === 'pending') { run.state = 'interrupted'; run.summary = 'Unstarted check discarded by execution-mode change.'; run.finishedAt = new Date().toISOString(); this.save(run) }
  }
  assertModeChange(taskId: string): void {
    if (this.jobs.has(taskId) || this.db.getTasks().some(task => (task.id === taskId || task.recurrence_parent_id === taskId) && this.agents.findSessionByTaskId(task.id))) throw new Error('Stop the schedule task and its existing instance sessions before changing execution mode.')
  }
  async recover(taskId: string): Promise<void> {
    const run = this.active(taskId)
    if (!run || run.state !== 'interrupted' || this.jobs.has(taskId)) throw new Error('No interrupted check is ready for recovery.')
    const autoStart = this.db.getTask(taskId)?.auto_start_agent
    await this.agents.withStoppedTasks([taskId], async () => {
      await this.archive(run)
      run.finishedAt = new Date().toISOString(); this.save(run)
      this.db.updateTask(taskId, { auto_start_agent: !!autoStart })
    })
  }
  async releaseForControl(taskId: string): Promise<void> {
    await this.jobs.get(taskId)
    const run = this.active(taskId)
    if (!run) return
    if (this.agents.findSessionByTaskId(taskId)) throw new Error('The check runtime is still present.')
    await this.archive(run)
    run.state = 'interrupted'; run.summary = 'Stopped by task administration.'; run.finishedAt = new Date().toISOString(); this.save(run)
  }
  async stop(): Promise<void> { this.closing = true; await Promise.allSettled([...this.jobs.values()]) }
}
