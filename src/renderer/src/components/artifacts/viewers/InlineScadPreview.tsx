import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { Artifact } from '@shared/artifacts'

const ScadModelView = lazy(() => import('./ScadModelView').then((module) => ({ default: module.ScadModelView })))
const modelCache = new Map<string, string>()

/** A compact 3D view for a SCAD file named in the conversation. */
export function InlineScadPreview({ artifact, renderModel, onOpen }: {
  artifact: Artifact
  renderModel: (taskId: string, path: string) => Promise<string>
  onOpen: () => void
}) {
  const key = `${artifact.taskId}:${artifact.path}:${artifact.updatedAt}:${artifact.reloadTrigger}`
  const currentKey = useRef(key)
  currentKey.current = key
  const [open, setOpen] = useState(false)
  const [stl, setStl] = useState<string | null>(() => modelCache.get(key) || null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setOpen(false)
    setStl(modelCache.get(key) || null)
    setError(null)
  }, [key])

  const showModel = async () => {
    if (open) { setOpen(false); return }
    setOpen(true)
    if (stl || !artifact.path) return
    setBusy(true)
    setError(null)
    try {
      const model = await renderModel(artifact.taskId, artifact.path)
      modelCache.set(key, model)
      if (modelCache.size > 4) modelCache.delete(modelCache.keys().next().value!)
      if (currentKey.current === key) setStl(model)
    } catch (reason) {
      if (currentKey.current === key) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (currentKey.current === key) setBusy(false)
    }
  }

  return <div className="my-2 w-full max-w-[520px] overflow-hidden rounded-lg border border-border/50 bg-card" aria-label={`SCAD model ${artifact.title}`}>
    <div className="flex items-center gap-2 px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{artifact.title}</span>
      <button type="button" onClick={onOpen} className="text-xs text-primary hover:underline">Open editor</button>
      <button type="button" disabled={busy} onClick={() => void showModel()} className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground disabled:opacity-60">
        {busy ? 'Rendering…' : open ? 'Hide 3D' : 'Show 3D'}
      </button>
    </div>
    {open && <div className="h-[280px] border-t border-border/50">
      {stl ? <Suspense fallback={<div className="p-3 text-xs text-muted-foreground">Loading 3D view…</div>}><ScadModelView stl={stl} /></Suspense>
        : <div role={error ? 'alert' : undefined} className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">{error || 'Rendering model…'}</div>}
    </div>}
  </div>
}
