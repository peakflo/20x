import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, FolderPlus } from 'lucide-react'
import { agentApi, settingsApi } from '@/lib/ipc-client'
import { useTaskStore } from '@/stores/task-store'
import { applyUiCommand } from '@/lib/ui-remote-control'
import { Button } from '@/components/ui/Button'
import type { ProjectRecord, ResponsibilityRecord, ResponsibilitySnapshot, ResponsibilityNotice, ProjectMemory } from '@shared/responsibilities'
import { isSourceCollection } from '@shared/responsibilities'

const empty: ResponsibilitySnapshot = { projects: [], responsibilities: [], notices: [], memory: [], steps: [] }
const inputClass = 'w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm'

export function ResponsibilitiesPanel({ onProjectChange }: { onProjectChange: (project: ProjectRecord | null) => void }) {
  const api = window.electronAPI?.responsibilities
  const [snapshot, setSnapshot] = useState(empty)
  const [projectId, setProjectId] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [tab, setTab] = useState<'work' | 'decisions' | 'memory'>('work')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    if (api) setSnapshot(await api.snapshot())
  }, [api])
  useEffect(() => {
    if (!api) return
    void refresh().catch(e => setError(String(e)))
    void settingsApi.get('mastermind_project').then(id => { if (id) setProjectId(id) })
    return api.onChanged(() => { void refresh().catch(e => setError(String(e))) })
  }, [api, refresh])
  useEffect(() => { onProjectChange(snapshot.projects.find(p => p.id === projectId) ?? null) }, [projectId, snapshot.projects, onProjectChange])

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setError('')
    try { await action(); await refresh() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  if (!api) return null
  const records = snapshot.responsibilities.filter(r => r.projectId === projectId)
  const notices = snapshot.notices.filter(n => n.projectId === projectId)
  const pending = notices.filter(n => n.state === 'pending' && n.kind !== 'result')
  const unread = notices.filter(n => n.state === 'pending' && n.kind === 'result')
  const proposals = records.filter(r => r.state === 'proposed')
  return <section aria-label="Project responsibilities" className="shrink-0 rounded-2xl border border-border bg-card shadow-card">
    <div className="flex items-center gap-2 p-2">
      <button aria-label={expanded ? 'Collapse responsibilities' : 'Show responsibilities'} onClick={() => setExpanded(!expanded)} className="rounded p-1 hover:bg-accent">
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      <select aria-label="Engineering project" className={`${inputClass} min-w-0 flex-1`} value={projectId} onChange={e => {
        setProjectId(e.target.value); void settingsApi.set('mastermind_project', e.target.value)
      }}>
        <option value="">All tasks · choose a project</option>
        {snapshot.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <Button size="sm" variant="ghost" aria-label="Add engineering project" onClick={() => { setCreating(!creating); setExpanded(true) }}><FolderPlus size={16} /></Button>
    </div>
    {(pending.length > 0 || proposals.length > 0 || unread.length > 0) && <button onClick={() => { setExpanded(true); setTab(pending.length || unread.length ? 'decisions' : 'work') }} className="mx-3 mb-2 text-left text-xs font-medium text-primary" aria-live="polite">
      {pending.length > 0 ? `${pending.length} decision${pending.length === 1 ? '' : 's'} need you` : proposals.length ? `${proposals.length} agreement${proposals.length === 1 ? '' : 's'} to review` : `${unread.length} result${unread.length === 1 ? '' : 's'} ready`}
    </button>}
    {error && <p role="alert" className="px-3 pb-2 text-sm text-destructive">{error}</p>}
    {expanded && <div className="max-h-[45vh] overflow-y-auto border-t border-border p-3">
      {creating && <ProjectForm busy={busy} onCreate={(name, root, agentId) => run(async () => {
        const p = await api.createProject(name, root, agentId); setProjectId(p.id); await settingsApi.set('mastermind_project', p.id); setCreating(false)
      })} />}
      {!projectId ? <p className="text-sm text-muted-foreground">Choose a project to teach Mastermind what matters, delegate work, and keep its agreements separate.</p> : <>
        <div role="tablist" aria-label="Responsibility views" className="mb-3 flex gap-1">
          {(['work', 'decisions', 'memory'] as const).map(value => <button key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value)} className={`rounded-md px-3 py-1 text-xs capitalize ${tab === value ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}>{value}</button>)}
        </div>
        {tab === 'work' && <div className="space-y-3">
          {records.length === 0 && <p className="text-sm text-muted-foreground">Ask for a Task, describe a Goal, or teach a Routine in the conversation below. Mastermind will propose the agreement here.</p>}
          {records.map(r => <div key={r.id}><AgreementCard record={r} unresolved={snapshot.steps.some(s => s.responsibilityId === r.id && !['held', 'settled'].includes(s.state))} busy={busy} act={action => run(() => api.act(r.id, r.revision, action))} />
            {snapshot.steps.filter(s => s.responsibilityId === r.id).map(s => <div key={s.id} className="ml-2 mt-1 rounded border border-border p-2 text-xs">
              <button className="font-medium text-primary underline" onClick={() => void run(async () => { await useTaskStore.getState().fetchTasks(); const opened = applyUiCommand({ kind: 'open_task', taskId: s.taskId, where: 'modal' }); if (!opened.applied) throw new Error(opened.detail) })}>Open {s.phase} · {s.state.replace('_', ' ')}</button>
              {s.report && <details className="mt-1"><summary className="cursor-pointer">{s.report.summary}</summary><p className="mt-1 break-all">{s.report.work.checkout} · {s.report.work.revision}</p><ul className="mt-1 list-inside list-disc">{s.report.evidence.map((e, i) => <li className="break-words" key={i}>{e}</li>)}</ul></details>}
            </div>)}
          </div>)}
        </div>}
        {tab === 'decisions' && <div className="space-y-3">
          {notices.length === 0 && <p className="text-sm text-muted-foreground">Results and questions arrive here, even when the conversation is busy.</p>}
          {[...notices].sort((a, b) => Number(b.state === 'pending') - Number(a.state === 'pending') || b.createdAt.localeCompare(a.createdAt)).map(n => <NoticeCard key={n.id} notice={n} busy={busy} answer={(answer, approved) => run(() => api.answer(n.id, answer, approved))} />)}
        </div>}
        {tab === 'memory' && <MemoryEditor key={projectId} memory={snapshot.memory.filter(m => m.projectId === projectId)} busy={busy} save={(kind, value, id) => run(() => api.remember(projectId, kind, value, id))} forget={id => run(() => api.forget(id))} />}
        <p className="mt-3 text-[11px] text-muted-foreground">Fully quitting 20x stops agents and monitoring. Saved work and decisions remain available when you reopen.</p>
      </>}
    </div>}
  </section>
}

function AgreementCard({ record: r, unresolved, busy, act }: { record: ResponsibilityRecord; unresolved: boolean; busy: boolean; act: (action: Parameters<NonNullable<typeof window.electronAPI.responsibilities>['act']>[2]) => Promise<void> }) {
  const a = r.agreement
  return <article className="rounded-lg border border-border p-3 text-sm">
    <div className="flex items-start justify-between gap-2"><strong>{a.title}</strong><span className="text-xs capitalize text-muted-foreground">{a.kind} · {r.state.replace('_', ' ')}</span></div>
    <p className="mt-1 whitespace-pre-wrap">{a.objective}</p>
    <details className="mt-2" open={r.state === 'proposed'}>
      <summary className="cursor-pointer text-xs text-muted-foreground">Agreement and evidence</summary>
      <dl className="mt-2 space-y-2 text-xs">
        {[['Scope', a.scope], ['Success evidence', a.finish], ['Stop conditions', a.stop], ['Allowed work', a.mode === 'edit' ? 'Workspace edits within this scope' : 'Read-only investigation'], ['Budget', `${r.steps} of ${a.maxSteps} steps · until ${new Date(a.deadline).toLocaleString()}`], ['Next step', r.next?.instruction ?? 'Waiting for a result, decision, or scheduled check']].map(([label, value]) => <div key={label}><dt className="font-medium">{label}</dt><dd className="whitespace-pre-wrap text-muted-foreground">{value}</dd></div>)}
        {a.schedule && <div><dt className="font-medium">Schedule</dt><dd>{a.schedule}{r.nextAt ? ` · next ${new Date(r.nextAt).toLocaleString()}` : ''}</dd></div>}
        {a.source && <div><dt className="font-medium">Source trial</dt><dd className="space-y-1"><p>{a.source.description}</p>
          {isSourceCollection(a.source) ? <>
            {a.source.reads.map((read, i) => <div key={i} className="rounded bg-muted p-2"><p>{read.description}</p>
              {read.kind === 'mcp' ? <><p>{read.serverName ?? read.serverId} · {read.tool}</p><pre className="whitespace-pre-wrap break-all">{JSON.stringify(read.arguments, null, 2)}</pre>
                {read.pagination && <p>Read up to {read.pagination.maxPages} pages. Cursor: {read.pagination.cursorArgument}; next cursor: {read.pagination.nextCursorPath}; items: {read.pagination.itemsPath}.</p>}
                {read.select && <p>Compare fields: {read.select.join(', ')}</p>}
              </> : <code className="block break-all">{read.command} {read.args.map(v => JSON.stringify(v)).join(' ')}</code>}
            </div>)}
            {a.source.reasoning && <p>Collection reasoning: {a.source.reasoning}. Each check, including the trial, uses one assignment from the budget, limited to one minute.</p>}
            <p>Inspect the exact operations above and confirm they only read the intended scope. Connection tool descriptions do not grant permission.</p>
          </> : <code className="block break-all rounded bg-muted p-2">{a.source.command} {a.source.args.map(v => JSON.stringify(v)).join(' ')}</code>}
          <p>Run this collector to confirm the source, then inspect the sample before activation.</p></dd></div>}
        {r.lastCollectedAt && <div><dt className="font-medium">Last successful check</dt><dd>{new Date(r.lastCollectedAt).toLocaleString()}</dd></div>}
        {r.trial && <div><dt className="font-medium">Collected {new Date(r.trial.at).toLocaleString()}</dt><dd><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{r.trial.output || '(empty source)'}</pre></dd></div>}
        {r.trial?.evidence && <div><dt className="font-medium">Evidence used for collection reasoning</dt><dd><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{r.trial.evidence}</pre></dd></div>}
      </dl>
    </details>
    <div className="mt-3 flex flex-wrap gap-2">
      {r.state === 'proposed' && <>
        {a.source && <Button size="sm" variant="outline" disabled={busy || unresolved} onClick={() => void act('trial')}>{unresolved ? 'Source reasoning in progress' : 'Run source trial'}</Button>}
        <Button size="sm" disabled={busy || unresolved || (!!a.source && r.trial?.revision !== r.revision)} onClick={() => void act('approve')}>{a.kind === 'routine' ? 'Approve and activate' : 'Approve and start'}</Button>
      </>}
      {r.state === 'active' && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('pause')}>Pause new work</Button>}
      {r.state === 'paused' && <Button size="sm" disabled={busy} onClick={() => void act('resume')}>Resume</Button>}
      {r.state === 'blocked' && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('recover')}>Recover after inspection</Button>}
      {['active', 'paused', 'blocked'].includes(r.state) && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('takeover')}>Take over</Button>}
      {r.state === 'cancelled' && unresolved && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('recover')}>Release cancelled work after inspection</Button>}
      {r.state === 'taken_over' && unresolved && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('takeover')}>Finish takeover</Button>}
      {r.state === 'taken_over' && !unresolved && <Button size="sm" disabled={busy} onClick={() => void act('handback')}>Hand back</Button>}
      {!['completed', 'cancelled'].includes(r.state) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act('cancel')}>Cancel responsibility</Button>}
    </div>
  </article>
}

function NoticeCard({ notice: n, busy, answer }: { notice: ResponsibilityNotice; busy: boolean; answer: (answer: string, approved?: boolean) => Promise<void> }) {
  const [reply, setReply] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  return <article className="rounded-lg border border-border p-3 text-sm">
    <div className="flex justify-between gap-2"><strong>{n.title}</strong><span className="text-xs text-muted-foreground">{n.state}</span></div>
    <p className="mt-2 whitespace-pre-wrap break-words">{n.body}</p>
    {n.answer && <p className="mt-2 whitespace-pre-wrap text-muted-foreground">Your answer: {n.answer}</p>}
    {n.state === 'expired' && <p className="mt-2 text-xs text-muted-foreground">The original request is no longer live. Inspect and recover its responsibility.</p>}
    {n.state === 'pending' && n.kind === 'recovery' && <p className="mt-2 text-xs text-muted-foreground">Open Work to inspect the agreement, then recover or take over.</p>}
    {n.state === 'pending' && n.kind === 'result' && <Button size="sm" variant="ghost" onClick={() => void answer('Read')} disabled={busy}>Mark read</Button>}
    {n.state === 'pending' && ['question', 'permission'].includes(n.kind) && <form className="mt-3 space-y-2" onSubmit={e => { e.preventDefault(); void answer(n.questions ? JSON.stringify(answers) : reply || 'Approved', n.kind === 'permission') }}>
      {n.questions ? n.questions.map(q => <label key={q.question} className="block text-xs">{q.question}<textarea aria-label={`${n.title}: ${q.header}`} className={inputClass} value={answers[q.question] ?? ''} onChange={e => setAnswers({ ...answers, [q.question]: e.target.value })} required /></label>) : <textarea aria-label={`Answer ${n.title}`} className={inputClass} value={reply} onChange={e => setReply(e.target.value)} placeholder="Your decision or clarification" required={n.kind === 'question'} />}
      <div className="flex gap-2"><Button size="sm" disabled={busy}>{n.kind === 'permission' ? 'Approve this request' : 'Send answer'}</Button>
        {n.kind === 'permission' && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void answer(reply || 'Rejected', false)}>Reject</Button>}</div>
    </form>}
  </article>
}

function ProjectForm({ busy, onCreate }: { busy: boolean; onCreate: (name: string, root: string, agentId: string) => Promise<void> }) {
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([])
  useEffect(() => { void agentApi.getAll().then(setAgents) }, [])
  return <form className="mb-4 space-y-2" onSubmit={e => {
    e.preventDefault(); const data = new FormData(e.currentTarget)
    void onCreate(String(data.get('name')), String(data.get('root')), String(data.get('agent')))
  }}>
    <label className="block text-xs">Project name<input name="name" className={inputClass} required maxLength={160} /></label>
    <label className="block text-xs">Project folder<input name="root" className={inputClass} required placeholder="/path/to/project" /></label>
    <label className="block text-xs">Default agent<select name="agent" className={inputClass} required>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
    <Button size="sm" disabled={busy}>Create project</Button>
  </form>
}

function MemoryEditor({ memory, busy, save, forget }: { memory: ProjectMemory[]; busy: boolean; save: (kind: 'fact' | 'preference', text: string, id?: string) => Promise<void>; forget: (id: string) => Promise<void> }) {
  const [kind, setKind] = useState<'fact' | 'preference'>('preference')
  const [value, setValue] = useState('')
  const [editing, setEditing] = useState<string>()
  return <div className="space-y-3">
    <p className="text-xs text-muted-foreground">Facts and preferences guide work. Permissions remain in the approved agreement.</p>
    {memory.map(m => <article key={m.id} className="rounded-lg border border-border p-2 text-sm"><span className="text-xs capitalize text-muted-foreground">{m.kind}</span><p className="whitespace-pre-wrap">{m.text}</p><p className="mt-1 text-xs text-muted-foreground">{m.provenance}</p><div className="mt-1 flex gap-2"><button className="text-xs text-primary" onClick={() => { setEditing(m.id); setKind(m.kind); setValue(m.text) }}>Edit</button><button disabled={busy} className="text-xs text-muted-foreground" onClick={() => void forget(m.id)}>Forget</button></div></article>)}
    <form className="space-y-2" onSubmit={e => { e.preventDefault(); void save(kind, value, editing) }}>
      <select aria-label="Memory kind" className={inputClass} value={kind} onChange={e => setKind(e.target.value as 'fact' | 'preference')}><option value="preference">Preference</option><option value="fact">Fact</option></select>
      <textarea aria-label="Remembered information" className={inputClass} value={value} onChange={e => setValue(e.target.value)} required maxLength={12000} />
      <Button size="sm" disabled={busy}>{editing ? 'Save correction' : 'Remember'}</Button>
      {editing && <Button type="button" size="sm" variant="ghost" onClick={() => { setEditing(undefined); setValue('') }}>Cancel edit</Button>}
    </form>
  </div>
}
