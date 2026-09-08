import { useEffect, useState } from 'react'
import type { ScheduleRun } from '@shared/schedule-runs'
import { taskApi, onTaskUpdated } from '@/lib/ipc-client'
import { Button } from '@/components/ui/Button'

type Detail = ScheduleRun & { transcript: { partId: string; role: string; content: string; tool?: unknown }[] }
export function ScheduleRunHistory({ taskId, hideEmpty = false }: { taskId: string; hideEmpty?: boolean }) {
  const [runs, setRuns] = useState<ScheduleRun[]>([])
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  useEffect(() => {
    let live = true
    setRuns([]); setDetail(null); setError('')
    const refresh = async () => {
      try { const rows = await taskApi.getScheduleRuns(taskId) as ScheduleRun[]; if (live) { setRuns(rows); setHasMore(rows.length === 20) } }
      catch (e) { if (live) setError(String(e)) }
    }
    void refresh()
    const off = onTaskUpdated(e => { if (e.taskId === taskId) void refresh() })
    return () => { live = false; off() }
  }, [taskId])
  const act = async (action: string) => {
    setBusy(true); setError('')
    try { const result = await taskApi.manageScheduleTask(taskId, action); if (result.error) throw new Error(result.error) }
    catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }
  if (hideEmpty && !runs.length && !error) return null
  return <div className="space-y-2 rounded border border-border p-3">
    <strong className="text-sm">Check history</strong>
    {!runs.length && <p className="text-xs text-muted-foreground">No checks recorded.</p>}
    {runs.map(run => <div key={run.id} className="border-t border-border pt-2 text-sm">
      <button className="text-primary underline" onClick={async () => { try { setDetail(await taskApi.getScheduleRuns(taskId, run.id) as Detail) } catch (e) { setError(String(e)) } }}>{new Date(run.dueAt).toLocaleString()} · {run.state.replace('_', ' ')}</button>
      {run.summary && <p className="whitespace-pre-wrap text-xs text-muted-foreground">{run.summary.slice(0, 1200)}</p>}
      {run.state === 'interrupted' && !run.finishedAt && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('recover_schedule')}>Release after inspection</Button>}
    </div>)}
    {hasMore && <Button size="sm" variant="ghost" disabled={busy} onClick={async () => { setBusy(true); try { const older = await taskApi.getScheduleRuns(taskId, undefined, runs.at(-1)!.dueAt) as ScheduleRun[]; setRuns(current => [...current, ...older]); setHasMore(older.length === 20) } catch (e) { setError(String(e)) } finally { setBusy(false) } }}>Load older checks</Button>}
    {detail && <details open className="rounded border border-border p-2"><summary>{new Date(detail.dueAt).toLocaleString()} · {detail.state.replace('_', ' ')}</summary>
      {detail.transcript.map(part => <details key={part.partId}><summary className="text-xs capitalize">{part.role}{part.tool ? ' · tool' : ''}</summary><pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs">{part.content || JSON.stringify(part.tool, null, 2)}</pre></details>)}
      {detail.artifacts.map(a => <button key={a.path} className="block text-xs text-primary underline" onClick={() => void window.electronAPI.shell.openPath(a.path)}>{a.title}</button>)}
    </details>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>
}
