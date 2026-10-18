import { useEffect, useState } from 'react'
import { Monitor, Square } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import type { ComputerStatus, ComputerWindow } from '@shared/computer-use'

export function ComputerUseControl({ taskId }: { taskId: string }) {
  const [status, setStatus] = useState<ComputerStatus>({ grant: null })
  const [windows, setWindows] = useState<ComputerWindow[]>([])
  const [selected, setSelected] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!window.electronAPI?.computerUse) return
    const refresh = (): void => { void window.electronAPI.computerUse.status().then(setStatus).catch(() => {}) }
    refresh()
    const timer = window.setInterval(refresh, 2000)
    window.addEventListener('computer-use-changed', refresh)
    return () => { window.clearInterval(timer); window.removeEventListener('computer-use-changed', refresh) }
  }, [])

  if (!window.electronAPI?.computerUse) return null
  const grant = status.grant
  const ownGrant = grant?.taskId === taskId

  const discover = async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const found = await window.electronAPI.computerUse.listWindows()
      setWindows(found.filter((item) => item.app_name.toLowerCase() !== '20x'))
      setSelected('')
      setConfirmed(false)
    } catch (cause) {
      setError((cause as Error).message)
    } finally { setLoading(false) }
  }

  const enable = async (): Promise<void> => {
    const target = windows.find((item) => `${item.pid}:${item.window_id}` === selected)
    if (!target) return
    setLoading(true)
    setError('')
    try {
      const next = await window.electronAPI.computerUse.grant(taskId, target.pid, target.window_id)
      setStatus({ grant: next })
      window.dispatchEvent(new Event('computer-use-changed'))
    } catch (cause) { setError((cause as Error).message) }
    finally { setLoading(false) }
  }

  const stop = async (): Promise<void> => {
    setLoading(true)
    try {
      setStatus(await window.electronAPI.computerUse.stop(taskId))
      window.dispatchEvent(new Event('computer-use-changed'))
    } catch (cause) { setError((cause as Error).message) }
    finally { setLoading(false) }
  }

  return (
    <>
      <span className="text-muted-foreground flex items-center gap-2"><Monitor className="h-3.5 w-3.5" /> Computer Use</span>
      <div className="flex flex-col gap-2">
        {ownGrant ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-foreground">Controlling {grant.window.app_name} — {grant.window.title || 'Untitled window'}</span>
            <Button variant="outline" size="sm" className="h-7 gap-1.5" disabled={loading} onClick={stop}><Square className="h-3 w-3" /> Stop control</Button>
          </div>
        ) : grant ? (
          <span className="text-xs text-muted-foreground">In use by another task. Stop that task’s control before enabling this one.</span>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="outline" size="sm" className="h-7" disabled={loading} onClick={discover}>Choose window…</Button>
            {windows.length > 0 && (
              <>
                <select aria-label="Window to grant" className="max-w-64 rounded border border-border bg-background px-2 py-1 text-xs" value={selected} onChange={(event) => { setSelected(event.target.value); setConfirmed(false) }}>
                  <option value="">Select one window</option>
                  {windows.map((item) => <option key={`${item.pid}:${item.window_id}`} value={`${item.pid}:${item.window_id}`}>{item.app_name} — {item.title || 'Untitled'}{item.is_on_screen ? '' : ' (off-screen)'}</option>)}
                </select>
                <Button variant="outline" size="sm" className="h-7" disabled={!selected || !confirmed || loading} onClick={enable}>Allow this task</Button>
              </>
            )}
          </div>
        )}
        {!grant && windows.length > 0 && <label className="flex items-start gap-1.5 text-[11px] text-muted-foreground"><input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />The agent may read, type, and click in this window, including actions with real effects. I can stop it at any time.</label>}
        <span className="text-[11px] text-muted-foreground">Native app access, separate from Browser Use. 20x limits the agent to this window; Cua may require broader OS screen permissions.</span>
        {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
      </div>
    </>
  )
}
