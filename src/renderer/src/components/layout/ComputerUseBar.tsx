import { useEffect, useState } from 'react'
import { Monitor, Square } from 'lucide-react'
import type { ComputerGrant } from '@shared/computer-use'

export function ComputerUseBar() {
  const [grant, setGrant] = useState<ComputerGrant | null>(null)
  useEffect(() => {
    if (!window.electronAPI?.computerUse) return
    const refresh = (): void => { void window.electronAPI.computerUse.status().then((status) => setGrant(status.grant)).catch(() => {}) }
    refresh()
    const timer = window.setInterval(refresh, 2000)
    window.addEventListener('computer-use-changed', refresh)
    return () => { window.clearInterval(timer); window.removeEventListener('computer-use-changed', refresh) }
  }, [])
  if (!grant) return null
  return (
    <div className="flex shrink-0 items-center justify-center gap-3 border-b border-warning/40 bg-warning/10 px-3 py-1 text-xs" role="status">
      <Monitor className="h-3.5 w-3.5" />
      <span className="truncate">Computer Use active: {grant.window.app_name} — {grant.window.title || 'Untitled window'}</span>
      <button className="flex items-center gap-1 rounded border border-warning/50 px-2 py-0.5 hover:bg-warning/20" onClick={() => { void window.electronAPI.computerUse.stop(grant.taskId).then(() => window.dispatchEvent(new Event('computer-use-changed'))) }}>
        <Square className="h-2.5 w-2.5" /> Stop
      </button>
    </div>
  )
}
