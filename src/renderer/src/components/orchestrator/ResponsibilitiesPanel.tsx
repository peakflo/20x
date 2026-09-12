import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FolderPlus, Pause, Play } from 'lucide-react'
import { agentApi, settingsApi } from '@/lib/ipc-client'
import { useTaskStore } from '@/stores/task-store'
import { applyUiCommand } from '@/lib/ui-remote-control'
import { Button } from '@/components/ui/Button'
import { CollapsibleDescription } from '@/components/ui/CollapsibleDescription'
import type { ProjectRecord, ResponsibilityRecord, ResponsibilitySnapshot, ResponsibilityNotice, ProjectMemory } from '@shared/responsibilities'
import { isSourceCollection } from '@shared/responsibilities'
import { FactoryConfirmation, FactoryGuide } from '@/components/factories/FactoriesWorkspace'
import { useUIStore } from '@/stores/ui-store'

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
  const [reviewId, setReviewId] = useState<string | null>(null)
  const reviewRef = useRef<HTMLDivElement>(null)
  const projectChosen = useRef(false)
  const draft = useUIStore(s => s.mastermindDraft)
  const openProject = useUIStore(s => s.mastermindProjectToOpen)
  useEffect(() => { if (openProject) { projectChosen.current = true; setProjectId(openProject); setExpanded(true); useUIStore.setState({ mastermindProjectToOpen: null }) } }, [openProject])
  useEffect(() => {
    if (!draft) return
    projectChosen.current = true
    setProjectId(draft.projectId); setExpanded(true)
    void settingsApi.set('mastermind_project', draft.projectId).catch(e => setError(String(e)))
  }, [draft])
  const refresh = useCallback(async () => {
    if (api) setSnapshot(await api.snapshot())
  }, [api])
  useEffect(() => {
    if (!api) return
    void refresh().catch(e => setError(String(e)))
    void settingsApi.get('mastermind_project').then(id => { if (id && !projectChosen.current) setProjectId(id) })
    return api.onChanged(() => { void refresh().catch(e => setError(String(e))) })
  }, [api, refresh])
  useEffect(() => { onProjectChange(snapshot.projects.find(p => p.id === projectId) ?? null) }, [projectId, snapshot.projects, onProjectChange])
  useEffect(() => { setReviewId(null) }, [projectId])
  useEffect(() => {
    if (tab !== 'work' || !reviewId) return
    reviewRef.current?.scrollIntoView({ block: 'nearest' })
    reviewRef.current?.focus({ preventScroll: true })
  }, [tab, reviewId])

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
  const factoryProposals = (snapshot.factoryProposals ?? []).filter(p => p.definition.projectId === projectId)
  const followup = snapshot.followups?.[projectId]
  const proactiveEnabled = followup?.enabled !== false
  return <section aria-label="Project responsibilities" className="shrink-0 rounded-2xl border border-border bg-card shadow-card">
    <div className="flex items-center gap-2 p-2">
      <button aria-label={expanded ? 'Collapse responsibilities' : 'Show responsibilities'} onClick={() => setExpanded(!expanded)} className="rounded p-1 hover:bg-accent">
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      <select aria-label="Engineering project" className={`${inputClass} min-w-0 flex-1`} value={projectId} onChange={e => {
        projectChosen.current = true
        setProjectId(e.target.value); void settingsApi.set('mastermind_project', e.target.value)
      }}>
        <option value="">All tasks · choose a project</option>
        {snapshot.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <Button size="sm" variant="ghost" aria-label="Add engineering project" onClick={() => { setCreating(!creating); setExpanded(true) }}><FolderPlus size={16} /></Button>
    </div>
    {projectId && <div className="mx-3 mb-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status">Proactive follow-up · {proactiveEnabled ? followup?.reviewing ? 'Reviewing' : 'On' : 'Paused'}</p>
        <Button type="button" size="sm" variant="outline" disabled={busy} aria-label={proactiveEnabled ? 'Pause proactive follow-up' : 'Continue proactive follow-up'} title="Controls automatic reviews and follow-ups for this project. Tasks and schedules keep their own controls." onClick={() => void run(() => api.setProactive(projectId, !proactiveEnabled))}>
          {proactiveEnabled ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
          {proactiveEnabled ? 'Pause' : 'Continue'}
        </Button>
      </div>
      {followup?.error && <p className="mt-1" role="alert">{followup.error} <button type="button" className="underline" onClick={() => void run(() => api.retryFollowups(projectId))}>Retry follow-up</button></p>}
    </div>}
    {(pending.length > 0 || proposals.length > 0 || unread.length > 0 || factoryProposals.length > 0) && <button onClick={() => { setExpanded(true); setTab(pending.length || unread.length ? 'decisions' : 'work') }} className="mx-3 mb-2 text-left text-xs font-medium text-primary" aria-live="polite">
      {factoryProposals.length ? `${factoryProposals.length} Factory preview(s) to review` : pending.length > 0 ? `${pending.length} decision${pending.length === 1 ? '' : 's'} need you` : proposals.length ? `${proposals.length} agreement${proposals.length === 1 ? '' : 's'} to review` : `${unread.length} result${unread.length === 1 ? '' : 's'} ready`}
    </button>}
    {error && <p role="alert" className="px-3 pb-2 text-sm text-destructive">{error}</p>}
    {expanded && <div className="max-h-[45vh] overflow-y-auto border-t border-border p-3">
      {creating && <ProjectForm busy={busy} onCreate={(name, root, agentId) => run(async () => {
        const p = await api.createProject(name, root, agentId); projectChosen.current = true; setProjectId(p.id); await settingsApi.set('mastermind_project', p.id); setCreating(false)
      })} />}
      {!projectId ? <p className="text-sm text-muted-foreground">Choose a project to teach Mastermind what matters, delegate work, and keep its agreements separate.</p> : <>
        <div className="mb-3 space-y-3">{factoryProposals.map(p => <FactoryConfirmation key={p.id} proposal={p} busy={busy} decide={(id, approve) => run(() => api.decideFactory(id, approve))} />)}</div>
        <div role="tablist" aria-label="Responsibility views" className="mb-3 flex gap-1">
          {(['work', 'decisions', 'memory'] as const).map(value => <button key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value)} className={`rounded-md px-3 py-1 text-xs capitalize ${tab === value ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}>{value}</button>)}
        </div>
        {tab === 'work' && <div className="space-y-3">
          {records.length === 0 && <p className="text-sm text-muted-foreground">Ask for a Task, describe a Goal, or teach a Routine in the conversation below. Mastermind will propose the agreement here.</p>}
          {records.map(r => <div key={r.id} ref={r.id === reviewId ? reviewRef : undefined} tabIndex={r.id === reviewId ? -1 : undefined}><AgreementCard record={r} reviewing={r.id === reviewId} unresolved={snapshot.steps.some(s => s.responsibilityId === r.id && !['held', 'settled'].includes(s.state))} busy={busy} act={action => run(() => api.act(r.id, r.revision, action))} />
            {snapshot.steps.filter(s => s.responsibilityId === r.id).map(s => <div key={s.id} className="ml-2 mt-1 rounded border border-border p-2 text-xs">
              <button className="font-medium text-primary underline" onClick={() => void run(async () => { await useTaskStore.getState().fetchTasks(); const opened = applyUiCommand({ kind: 'open_task', taskId: s.taskId, where: 'modal' }); if (!opened.applied) throw new Error(opened.detail) })}>Open {s.phase} · {s.state.replace('_', ' ')}</button>
              {s.report && <details className="mt-1"><summary className="cursor-pointer">Result and evidence</summary><p className="mt-2 whitespace-pre-wrap">{s.report.summary}</p><p className="mt-1 break-all">{s.report.work.checkout} · {s.report.work.revision}</p><ul className="mt-1 list-inside list-disc">{s.report.evidence.map((e, i) => <li className="break-words" key={i}>{e}</li>)}</ul></details>}
            </div>)}
          </div>)}
        </div>}
        {tab === 'decisions' && <div className="space-y-3">
          {notices.length === 0 && <p className="text-sm text-muted-foreground">Results and questions arrive here, even when the conversation is busy.</p>}
          {[...notices].sort((a, b) => Number(b.state === 'pending') - Number(a.state === 'pending') || b.createdAt.localeCompare(a.createdAt)).map(n => {
            const step = snapshot.steps.find(s => s.id === n.stepId && s.responsibilityId === n.responsibilityId)
            const prior = snapshot.steps.filter(s => s.responsibilityId === n.responsibilityId && s.createdAt <= (step?.createdAt ?? n.createdAt)).reverse()
            const target = step && step.phase !== 'coordinate' ? step : prior.find(s => s.phase === 'work') ?? step ?? prior[0]
            return <NoticeCard key={n.id} notice={n} busy={busy}
              reviewWork={records.some(r => r.id === n.responsibilityId) ? () => { setReviewId(n.responsibilityId); setTab('work') } : undefined}
              openTask={target ? () => run(async () => { await useTaskStore.getState().fetchTasks(); const result = applyUiCommand({ kind: 'open_task', taskId: target.taskId, where: 'modal' }); if (!result.applied) throw new Error(result.detail) }) : undefined}
              answer={(answer, approved) => run(() => api.answer(n.id, answer, approved))} />
          })}
        </div>}
        {tab === 'memory' && <MemoryEditor key={projectId} memory={snapshot.memory.filter(m => m.projectId === projectId)} busy={busy} save={(kind, value, id) => run(() => api.remember(projectId, kind, value, id))} forget={id => run(() => api.forget(id))} />}
        <p className="mt-3 text-[11px] text-muted-foreground">Fully quitting 20x stops agents and monitoring. Saved work and decisions remain available when you reopen.</p>
      </>}
    </div>}
  </section>
}

function AgreementCard({ record: r, reviewing, unresolved, busy, act }: { record: ResponsibilityRecord; reviewing: boolean; unresolved: boolean; busy: boolean; act: (action: Parameters<NonNullable<typeof window.electronAPI.responsibilities>['act']>[2]) => Promise<void> }) {
  const a = r.agreement
  return <article className="rounded-lg border border-border p-3 text-sm">
    <div className="mb-2 flex justify-between gap-2 text-xs capitalize text-muted-foreground"><span>{a.kind}</span><span>{r.state === 'taken_over' ? 'paused' : r.state.replace('_', ' ')}</span></div>
    <CollapsibleDescription taskId={`work-title-${r.id}`} description={a.title} collapsedLines={2} className="[&_p]:font-semibold" />
    <CollapsibleDescription taskId={`work-summary-${r.id}`} description={a.summary ?? a.objective} collapsedLines={3} className="mt-2 text-muted-foreground" />
    {r.routineSetup && <p className="mt-2 text-xs text-muted-foreground">{r.routineSetup.proposalId ? 'Routine proposal saved.' : 'Preparing a routine. Monitoring has not started.'}</p>}
    {a.stopOnSuccess && <p className="mt-2 text-xs text-muted-foreground">Stop scheduling once the success evidence is independently verified.</p>}
    {a.factory && <details className="mt-2"><summary className="cursor-pointer">Factory: {a.factory.name}</summary><FactoryGuide definition={a.factory} /></details>}
    <details className="mt-2" open={reviewing || r.state === 'proposed'}>
      <summary className="cursor-pointer text-xs text-muted-foreground">Agreement and evidence</summary>
      {a.access && <p className="mt-2 text-xs text-muted-foreground">Worker access: {a.access.permissionMode === 'allow' ? 'Use configured permissions automatically' : 'Ask when required'} · {a.access.sandboxMode === 'danger-full-access' ? 'Full access — read-only work is an instruction, not a sandbox restriction' : a.access.sandboxMode}. Saved for this execution.</p>}
      {a.factoryAgents && <p className="mt-2 text-xs text-muted-foreground">Approved agents: {a.factoryAgents.map(agent => `${agent.name} (${agent.backend ?? 'default'} · ${agent.model ?? 'default model'}${agent.access ? ` · ${agent.access.sandboxMode} · ${agent.access.permissionMode}` : ''})`).join(', ')}</p>}
      <dl className="mt-2 space-y-2 text-xs">
        {a.summary && <div><dt className="font-medium">Full request</dt><dd className="whitespace-pre-wrap text-muted-foreground">{a.objective}</dd></div>}
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
      {(a.factory || r.eventFactory) && <Button size="sm" variant="outline" onClick={() => useUIStore.getState().showResponsibilityOnCanvas(r.id)}>Show on canvas</Button>}
      {r.state === 'proposed' && <>
        {a.source && <Button size="sm" variant="outline" disabled={busy || unresolved} onClick={() => void act('trial')}>{unresolved ? 'Source reasoning in progress' : 'Run source trial'}</Button>}
        <Button size="sm" disabled={busy || unresolved || (!!a.source && r.trial?.revision !== r.revision)} onClick={() => void act('approve')}>{a.kind === 'routine' ? 'Approve and activate' : 'Approve and start'}</Button>
      </>}
      {r.state === 'active' && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('pause')}>Pause new work</Button>}
      {['paused', 'taken_over'].includes(r.state) && <Button size="sm" disabled={busy} onClick={() => void act('resume')}>Resume</Button>}
      {r.state === 'blocked' && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('recover')}>Recover after inspection</Button>}
      {r.state === 'cancelled' && unresolved && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('recover')}>Release cancelled work after inspection</Button>}
      {!['completed', 'cancelled'].includes(r.state) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act('cancel')}>Cancel responsibility</Button>}
    </div>
  </article>
}

function NoticeCard({ notice: n, busy, answer, openTask, reviewWork }: { notice: ResponsibilityNotice; busy: boolean; openTask?: () => Promise<void>; reviewWork?: () => void; answer: (answer: string, approved?: boolean) => Promise<void> }) {
  const [reply, setReply] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const question = n.kind === 'question' && !n.questions ? /^Question:\s*([^\n]+)\nWhy:\s*([^\n]+)\nReply:\s*([\s\S]+)$/i.exec(n.body.trim()) : null
  return <article className="rounded-lg border border-border p-3 text-sm">
    <div className="mb-2 flex justify-between gap-2 text-xs text-muted-foreground"><span>{{ question: 'Decision', permission: 'Permission request', recovery: 'Needs attention', result: 'Update' }[n.kind]}</span><span className="capitalize">{n.state}</span></div>
    <CollapsibleDescription taskId={`notice-title-${n.id}`} description={question?.[1] ?? n.title} collapsedLines={2} className="[&_p]:font-semibold" />
    {question ? <>
      <dl className="mt-2 space-y-2">
        <div><dt className="text-xs font-medium text-muted-foreground">Why</dt><dd>{question[2]}</dd></div>
        <div><dt className="text-xs font-medium text-muted-foreground">Reply with</dt><dd>{question[3]}</dd></div>
      </dl>
      <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">Task context</summary><p className="mt-1 whitespace-pre-wrap break-words">{n.title}</p></details>
    </> : n.kind === 'permission' || n.questions ? <p className="mt-2 whitespace-pre-wrap break-words">{n.body}</p>
      : <CollapsibleDescription taskId={`notice-body-${n.id}`} description={n.body} collapsedLines={3} className="mt-2" />}
    <div className="mt-2 flex flex-wrap gap-2">
      {reviewWork && <Button size="sm" variant="outline" disabled={busy} onClick={reviewWork}>Review work</Button>}
      {openTask && <Button size="sm" variant="outline" disabled={busy} onClick={() => void openTask()}>Open task</Button>}
      {((n.state === 'pending' && n.kind === 'recovery') || n.state === 'expired') && <Button size="sm" disabled={busy} onClick={() => useUIStore.getState().draftInMastermind(n.projectId, `Help me resolve the follow-up "${n.title}". Review the saved progress, explain what needs my decision, and propose any changes for my approval before restarting.\n\nFollow-up: ${n.id}${n.responsibilityId ? `; work: ${n.responsibilityId}` : ''}`)}>Ask Mastermind</Button>}
    </div>
    {n.answer && <p className="mt-2 whitespace-pre-wrap text-muted-foreground">Your answer: {n.answer}</p>}
    {n.deliveryError && <p role="alert" className="mt-2 text-xs text-destructive">Approval delivery failed or is unconfirmed: {n.deliveryError}</p>}
    {n.state === 'expired' && <p className="mt-2 text-xs text-muted-foreground">This request expired. Review the work or ask Mastermind what to do next.</p>}
    {n.state === 'pending' && n.kind === 'recovery' && <p className="mt-2 text-xs text-muted-foreground">Review progress and limits, or ask Mastermind to help decide what happens next.</p>}
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
  const [root, setRoot] = useState('')
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState('')
  const pickFolder = async () => {
    setPicking(true); setError('')
    try {
      const folder = await window.electronAPI.responsibilities.pickProjectFolder()
      if (folder !== null) setRoot(folder)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setPicking(false) }
  }
  useEffect(() => { void agentApi.getAll().then(setAgents) }, [])
  return <form className="mb-4 space-y-2" onSubmit={e => {
    e.preventDefault(); const data = new FormData(e.currentTarget)
    void onCreate(String(data.get('name')), String(data.get('root')), String(data.get('agent')))
  }}>
    <label className="block text-xs">Project name<input name="name" className={inputClass} required maxLength={160} /></label>
    <div className="space-y-1">
      <label htmlFor="mastermind-project-folder" className="block text-xs">Project folder</label>
      <div className="flex items-center gap-2">
        <input id="mastermind-project-folder" name="root" className={`${inputClass} min-w-0 flex-1`} value={root} onChange={e => setRoot(e.target.value)} required placeholder="/path/to/project" />
        <Button type="button" size="sm" variant="outline" disabled={busy || picking} onClick={() => void pickFolder()}>Select folder</Button>
      </div>
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <label className="block text-xs">Default agent<select name="agent" className={inputClass} required>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
    <Button size="sm" disabled={busy || picking}>Create project</Button>
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
