import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { ComputerGrant } from '@shared/computer-use'

export function ComputerUseBanner() {
  const [grant, setGrant] = useState<ComputerGrant | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const refresh = (): void => { if (document.visibilityState === 'visible') void api.computerUse.status().then((status) => setGrant(status.grant)).catch(() => {}) }
    refresh()
    const timer = window.setInterval(refresh, 4000)
    document.addEventListener('visibilitychange', refresh)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [])
  if (!grant) return null
  return <div className="shrink-0 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground" role="status">
    <div className="flex items-center justify-between gap-2">
      <span className="truncate">Computer Use: {grant.window.app_name} — {grant.window.title || 'Untitled window'}</span>
      <button className="shrink-0 rounded border border-amber-500/50 px-2 py-1" onClick={() => { void api.computerUse.stop().then((status) => { setGrant(status.grant); setError('') }).catch((cause) => setError((cause as Error).message)) }}>Stop</button>
    </div>
    {error && <p role="alert" className="mt-1 text-red-500">{error}</p>}
  </div>
}
