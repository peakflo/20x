import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import type { BrowserImportResult, BrowserImportSource } from '@shared/browser-session-import'

interface BrowserSessionImportPanelProps {
  domain: string
  onClose: () => void
  onImported: () => void
}

export function BrowserSessionImportPanel({ domain, onClose, onImported }: BrowserSessionImportPanelProps) {
  const [sources, setSources] = useState<BrowserImportSource[]>([])
  const [browserId, setBrowserId] = useState('')
  const [profileId, setProfileId] = useState('')
  const [domains, setDomains] = useState(domain)
  const [scope, setScope] = useState<'selected' | 'all'>('selected')
  const [result, setResult] = useState<BrowserImportResult | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    window.electronAPI.browser.listImportSources()
      .then(found => { if (active) setSources(found) })
      .catch(() => { if (active) setMessage('Could not list browser profiles.') })
    return () => { active = false }
  }, [])

  const profiles = sources.find(source => source.id === browserId)?.profiles || []
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setMessage('')
    try { await action() }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Browser session operation failed.') }
    finally { setBusy(false) }
  }

  return <section aria-label="Import browser session" className="border-b border-border/30 bg-background px-3 py-3 text-xs shadow-sm">
    <div className="mx-auto max-w-2xl space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold text-sm">Import session for {domain}</h3>
          <p className="text-muted-foreground">Copy cookies from a browser profile into this agent browser.</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close import" className="rounded px-2 py-1 hover:bg-accent">✕</button>
      </div>
      <div className="flex flex-wrap gap-2">
        <select aria-label="Browser" className="rounded border bg-background px-2 py-1.5" value={browserId} onChange={event => { setBrowserId(event.target.value); setProfileId(''); setResult(null) }}>
          <option value="">Choose browser</option>
          {sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
        </select>
        <select aria-label="Profile" className="rounded border bg-background px-2 py-1.5" value={profileId} onChange={event => setProfileId(event.target.value)}>
          <option value="">Choose profile</option>
          {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
      </div>
      {!sources.length && <p className="text-muted-foreground">No supported browser profiles were found.</p>}
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-1"><input type="radio" checked={scope === 'selected'} onChange={() => setScope('selected')} /> Selected domains</label>
        <label className="flex items-center gap-1"><input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} /> All sites</label>
      </div>
      {scope === 'selected' && <div>
        <Input aria-label="Domains" value={domains} onChange={event => setDomains(event.target.value)} placeholder="example.com, internal.company.com" />
        <p className="mt-1 text-muted-foreground">The open page’s domain is selected. A domain also includes its subdomains.</p>
      </div>}
      {scope === 'all' && <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-amber-700 dark:text-amber-300">All sites gives agents access to every signed-in site in this profile, including email, banking, and single sign-on. Import only the domains agents need.</p>}
      <p className="text-muted-foreground">Close the source browser first. On macOS, approve its “Safe Storage” Keychain prompt; Safari may need Full Disk Access. Session cookies without an expiry may end when the app restarts.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || !browserId || !profileId || (scope === 'selected' && !domains.split(',').some(value => value.trim()))} onClick={() => run(async () => {
          const selected = scope === 'all' ? [] : domains.split(',').map(value => value.trim()).filter(Boolean)
          const imported = await window.electronAPI.browser.importSessions({ browserId: browserId as BrowserImportSource['id'], profileId, domains: selected })
          setResult(imported)
          if (imported.imported > 0) onImported()
        })}>Import sessions</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => {
          const removed = await window.electronAPI.browser.clearImportedSessions()
          setResult(null)
          setMessage(`Agent browser storage cleared (${removed} cookies removed).`)
        })}>Clear all agent browser sessions</Button>
      </div>
      {message && <p role="status">{message}</p>}
      {result && <div role="status"><p>{result.imported} imported; {result.skipped} skipped.</p>{result.unsupportedWindowsCookies > 0 && <p>{result.unsupportedWindowsCookies} Windows app-bound (v20) cookies could not be imported. These cookies are protected for their original browser.</p>}<ul className="list-disc pl-5">{Object.entries(result.byDomain).sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => <li key={name}>{name}: {count}</li>)}</ul></div>}
    </div>
  </section>
}
