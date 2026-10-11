import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { ArtifactContentKind, type Artifact, type ArtifactApi, type ArtifactContent } from '@shared/artifacts'
import { useArtifactContent } from './use-artifact-content'

const ScadModelView = lazy(() => import('./ScadModelView').then((module) => ({ default: module.ScadModelView })))
type ScadViewMode = 'model' | 'source' | 'both'

export function ScadArtifactView({ artifact, artifactApi, refreshTrigger = 0 }: { artifact: Artifact; artifactApi: ArtifactApi; refreshTrigger?: number }) {
  const state = useArtifactContent(artifact, artifactApi, refreshTrigger)
  if (state.loading && !state.content) return <div className="p-4 text-sm text-muted-foreground">Loading SCAD file…</div>
  if (state.error) return <div role="alert" className="p-4 text-sm text-red-400">{state.error}</div>
  return <ScadEditor key={artifact.path} artifact={artifact} content={state.content} read={artifactApi.read} save={artifactApi.saveScad} renderModel={artifactApi.renderScad} />
}

/** The same editor is used by desktop and mobile. */
export function ScadEditor({ artifact, content, read, save, renderModel }: {
  artifact: Artifact
  content: ArtifactContent | null
  read?: ArtifactApi['read']
  save?: ArtifactApi['saveScad']
  renderModel?: ArtifactApi['renderScad']
}) {
  const source = content?.kind === ArtifactContentKind.TEXT ? content.content : null
  const [base, setBase] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [stl, setStl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [externalChange, setExternalChange] = useState(false)
  const [viewMode, setViewMode] = useState<ScadViewMode>('both')
  const [sourceHeight, setSourceHeight] = useState(240)
  const layoutRef = useRef<HTMLDivElement>(null)
  const resizeStart = useRef<{ pointerId: number; y: number; height: number } | null>(null)
  const seenSource = useRef<string | null>(null)
  const dirty = base !== null && draft !== base

  const clampSourceHeight = (height: number) => Math.max(120, Math.min(height, (layoutRef.current?.clientHeight || 640) - 168))

  const renderSaved = useCallback(async () => {
    if (!artifact.path || !renderModel) return
    setBusy(true)
    setError(null)
    try {
      setStl(await renderModel(artifact.taskId, artifact.path))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [artifact.path, artifact.taskId, renderModel])

  useEffect(() => {
    if (source === null || seenSource.current === source) return
    seenSource.current = source
    if (base === null) {
      setBase(source)
      setDraft(source)
      void renderSaved()
    } else if (source !== base) {
      if (dirty) setExternalChange(true)
      else { setBase(source); setDraft(source); void renderSaved() }
    }
  }, [source, base, dirty, renderSaved])

  const saveDraft = async (): Promise<boolean> => {
    if (!artifact.path || !save || base === null) return false
    setBusy(true)
    setError(null)
    try {
      await save(artifact.taskId, artifact.path, draft, base)
      setBase(draft)
      setExternalChange(false)
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setExternalChange(true)
      return false
    } finally {
      setBusy(false)
    }
  }

  const saveAndPreview = async () => {
    setViewMode('both')
    if (dirty && !await saveDraft()) return
    await renderSaved()
  }

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    resizeStart.current = { pointerId: event.pointerId, y: event.clientY, height: sourceHeight }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  }

  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = resizeStart.current
    if (start?.pointerId !== event.pointerId) return
    setSourceHeight(clampSourceHeight(start.height + start.y - event.clientY))
  }

  const endResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (resizeStart.current?.pointerId !== event.pointerId) return
    resizeStart.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const reload = async () => {
    if (!read || !artifact.path) return
    setBusy(true)
    try {
      const latest = await read(artifact.taskId, artifact.path)
      if (latest?.kind !== ArtifactContentKind.TEXT) throw new Error('SCAD source is not available.')
      setBase(latest.content)
      setDraft(latest.content)
      setExternalChange(false)
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }

  if (source === null) return <div className="p-4 text-sm text-muted-foreground">SCAD source is not available.</div>
  return <div className="flex h-full min-h-0 flex-col">
    <div className="border-b border-border/50">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{artifact.path}</span>
        {dirty && <span className="text-xs text-amber-400">Unsaved</span>}
        {externalChange && <button type="button" disabled={busy || !read} onClick={() => void reload()} className="rounded-md px-2 py-1.5 text-xs text-amber-300 disabled:opacity-50">Reload</button>}
        <button type="button" disabled={busy || !dirty || !save} onClick={() => void saveDraft()} className="rounded-md border border-border/50 px-3 py-1.5 text-xs text-foreground disabled:opacity-50">Save</button>
        <button type="button" disabled={busy || !renderModel || (dirty && !save)} onClick={() => void saveAndPreview()} className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50">{busy ? 'Rendering…' : dirty ? 'Save and preview' : 'Preview 3D'}</button>
      </div>
      <div role="group" aria-label="SCAD view" className="flex gap-1 px-3 pb-2">
        {([['model', '3D artifact'], ['source', 'Source'], ['both', 'Both']] as const).map(([mode, label]) => (
          <button key={mode} type="button" aria-pressed={viewMode === mode} onClick={() => setViewMode(mode)} className={`rounded-md px-3 py-1 text-xs ${viewMode === mode ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'}`}>{label}</button>
        ))}
      </div>
    </div>
    {externalChange && <div role="alert" className="bg-amber-500/10 px-3 py-2 text-xs text-amber-300">The file changed on disk. Reload before you save.</div>}
    {error && <div role="alert" className="bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>}
    <div ref={layoutRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {viewMode !== 'source' && <div role="region" aria-label="SCAD 3D model" className="min-h-0 w-full flex-1 overflow-hidden">
        {stl ? <Suspense fallback={<div className="p-4 text-xs text-muted-foreground">Loading 3D view…</div>}><ScadModelView stl={stl} /></Suspense> : <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">{busy ? 'Rendering model…' : '3D preview is not available.'}</div>}
      </div>}
      {viewMode === 'both' && <div role="separator" aria-label="Resize source panel" aria-orientation="horizontal" aria-valuemin={120} aria-valuemax={Math.max(120, (layoutRef.current?.clientHeight || 640) - 168)} aria-valuenow={sourceHeight} tabIndex={0} onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        setSourceHeight((height) => clampSourceHeight(height + (event.key === 'ArrowUp' ? 20 : -20)))
      }} className="flex h-3 shrink-0 cursor-row-resize touch-none items-center justify-center border-t border-border/50 bg-card focus-visible:outline-2 focus-visible:outline-primary">
        <span className="h-1 w-10 rounded-full bg-muted-foreground/50" />
      </div>}
      {viewMode !== 'model' && <div role="region" aria-label="SCAD source panel" className={viewMode === 'both' ? 'min-h-0 w-full shrink-0' : 'min-h-0 w-full flex-1'} style={viewMode === 'both' ? { height: sourceHeight, maxHeight: 'calc(100% - 168px)' } : undefined}>
        <textarea aria-label="SCAD source" spellCheck={false} value={draft} onChange={(event) => setDraft(event.target.value)} className="h-full w-full resize-none border-0 bg-background p-3 font-mono text-xs text-foreground outline-none" />
      </div>}
    </div>
  </div>
}
