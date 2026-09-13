import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Markdown } from '@/components/ui/Markdown'
import { MermaidDiagram } from '@/components/ui/MermaidDiagram'
import { WorkspaceBadge } from '@/components/ui/WorkspaceBadge'
import { settingsApi } from '@/lib/ipc-client'
import { useUIStore } from '@/stores/ui-store'
import type { FactoryDefinition, FactoryProposal, ResponsibilitySnapshot } from '@shared/responsibilities'

export function FactoryGuide({ definition: f }: { definition: FactoryDefinition }) {
  const diagram = f.diagram.replace(/^```mermaid\s*\n?/, '').replace(/\n?```\s*$/, '')
  return <div className="space-y-4">
    <section aria-label="Factory diagram"><h3 className="mb-2 font-medium">Diagram</h3>
      {/^(flowchart|graph|sequenceDiagram|stateDiagram)/.test(diagram.trim()) ? <MermaidDiagram code={diagram} /> : <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">{diagram}</pre>}
    </section>
    <section aria-label="Factory instructions"><h3 className="mb-2 font-medium">Instructions</h3><Markdown>{f.guide}</Markdown></section>
  </div>
}

export function FactoryConfirmation({ proposal: p, busy, decide }: { proposal: FactoryProposal; busy: boolean; decide: (id: string, approve: boolean) => Promise<void> }) {
  return <article className="space-y-3 rounded-xl border border-primary/40 p-4 text-sm" aria-label={`Confirm Factory ${p.definition.name}`}>
    <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{p.operation === 'delete' ? 'Delete' : p.replacesDigest ? 'Replace' : 'Save'} Factory “{p.definition.name}”?</h3><WorkspaceBadge projectId={p.definition.projectId} /></div>
    <FactoryGuide definition={p.definition} />
    <p className="text-xs text-muted-foreground">Optional work guide. Project instructions and approved permissions still apply. Saving does not start work. Existing tasks retain their original guide.</p>
    {p.operation === 'delete' && <p>Remove this saved template? Existing tasks and results will remain.</p>}
    <div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => void decide(p.id, false)}>Discard</Button><Button size="sm" disabled={busy} onClick={() => void decide(p.id, true)}>{p.operation === 'delete' ? 'Confirm deletion' : 'Save this Factory'}</Button></div>
  </article>
}

export function FactoriesWorkspace() {
  const [snapshot, setSnapshot] = useState<ResponsibilitySnapshot | null>(null)
  const projectId = useUIStore(s => s.mastermindProjectId)
  const setProjectId = useUIStore(s => s.setMastermindProjectId)
  const syncMastermindSnapshot = useUIStore(s => s.syncMastermindSnapshot)
  const [selectedId, setSelectedId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const draft = useUIStore(s => s.draftInMastermind)
  useEffect(() => {
    const api = window.electronAPI?.responsibilities
    if (!api) { setError('Factories are unavailable.'); return }
    let live = true; let request = 0
    const refresh = async () => {
      const current = ++request
      try { const next = await api.snapshot(); if (live && current === request) { setSnapshot(next); syncMastermindSnapshot(next); setError('') } }
      catch (e) { if (live && current === request) setError(String(e)) }
    }
    void refresh(); const off = api.onChanged(() => { void refresh() })
    return () => { live = false; off() }
  }, [syncMastermindSnapshot])
  const factories = (snapshot?.factories ?? []).filter(f => !projectId || f.projectId === projectId)
  const selected = factories.find(f => f.id === selectedId) ?? factories[0]
  const proposals = (snapshot?.factoryProposals ?? []).filter(p => !projectId || p.definition.projectId === projectId)
  const decide = async (id: string, approve: boolean) => {
    setBusy(true); setError('')
    try { await window.electronAPI.responsibilities.decideFactory(id, approve); setSnapshot(await window.electronAPI.responsibilities.snapshot()) }
    catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  return <div className="h-full overflow-auto p-6" aria-label="Factories">
    <header className="mb-5 flex flex-wrap items-center gap-3"><div className="flex-1"><h1 className="text-xl font-semibold">Factories</h1><p className="text-sm text-muted-foreground">Your reusable ways of working, taught through Mastermind.</p></div>
      <select aria-label="Factory project" className="rounded border border-border bg-background p-2 text-sm" value={projectId} onChange={e => { setProjectId(e.target.value); void settingsApi.set('mastermind_project', e.target.value) }}><option value="">All workspaces</option>{snapshot?.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <Button disabled={!projectId} onClick={() => draft(projectId, 'Help me create a Factory for this project. My usual way of working is: ')}>Create in Mastermind</Button>
    </header>
    {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
    {!snapshot && !error && <p role="status">Loading Factories…</p>}
    {snapshot && !projectId && <p className="mb-3 text-sm text-muted-foreground">Choose a project to create a Factory.</p>}
    <div className="mb-5 space-y-4">{proposals.map(p => <FactoryConfirmation key={p.id} proposal={p} busy={busy} decide={decide} />)}</div>
    {snapshot && !factories.length && <p className="text-sm text-muted-foreground">No saved Factories yet. Describe your workflow to Mastermind, then confirm its diagram and instructions.</p>}
    {factories.length > 0 && <div className="grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)]"><nav aria-label="Saved Factories" className="space-y-1">{factories.map(f => <button key={f.id} aria-current={selected?.id === f.id ? 'true' : undefined} onClick={() => setSelectedId(f.id)} className={`block w-full rounded-lg p-3 text-left text-sm ${selected?.id === f.id ? 'bg-accent' : 'hover:bg-muted'}`}><strong>{f.name}</strong><WorkspaceBadge projectId={f.projectId} className="mt-1" /></button>)}</nav>
      {selected && <article className="min-w-0 space-y-4 rounded-xl border border-border p-5"><div className="flex flex-wrap items-center gap-2"><h2 className="flex-1 text-lg font-semibold">{selected.name}</h2><WorkspaceBadge projectId={selected.projectId} /><Button size="sm" onClick={() => draft(selected.projectId, `Use Factory "${selected.name}" (ID ${selected.id}) for this request: `)}>Use</Button><Button size="sm" variant="outline" onClick={() => draft(selected.projectId, `Help me revise Factory "${selected.name}" (ID ${selected.id}). The change I want is: `)}>Edit in Mastermind</Button></div><FactoryGuide definition={selected} /></article>}
    </div>}
  </div>
}
