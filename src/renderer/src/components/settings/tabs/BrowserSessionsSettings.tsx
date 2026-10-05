import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { SettingsSection } from '../SettingsSection'
import type { BrowserImportResult, BrowserImportSource } from '@shared/browser-session-import'

export function BrowserSessionsSettings() {
  const [sources, setSources] = useState<BrowserImportSource[]>([])
  const [browserId, setBrowserId] = useState('')
  const [profileId, setProfileId] = useState('')
  const [domains, setDomains] = useState('')
  const [scope, setScope] = useState<'all' | 'selected'>('selected')
  const [result, setResult] = useState<BrowserImportResult | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.electronAPI.browser.listImportSources().then(setSources).catch(() => setMessage('Could not list browser profiles.'))
  }, [])

  const profiles = sources.find(source => source.id === browserId)?.profiles || []
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setMessage('')
    try { await action() } catch (error) { setMessage(error instanceof Error ? error.message : 'Browser session operation failed.') }
    finally { setBusy(false) }
  }

  return <SettingsSection title="Browser sessions" description="Copy signed-in sessions into the built-in browser used by agents.">
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">This is a one-time local copy into the separate agent browser. Agents can browse imported sites as you. Close the source browser before importing. On macOS, approve the “Safe Storage” Keychain prompt for the selected browser. Safari may need Full Disk Access. Session cookies without an expiry may end when the app restarts.</p>
      <div className="flex flex-wrap gap-2">
        <select aria-label="Browser" className="rounded border bg-background px-2 py-1" value={browserId} onChange={event => { setBrowserId(event.target.value); setProfileId(''); setResult(null) }}>
          <option value="">Choose browser</option>
          {sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
        </select>
        <select aria-label="Profile" className="rounded border bg-background px-2 py-1" value={profileId} onChange={event => setProfileId(event.target.value)}>
          <option value="">Choose profile</option>
          {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
      </div>
      {!sources.length && <p className="text-muted-foreground">No supported browser profiles were found.</p>}
      <div className="flex gap-4">
        <label className="flex items-center gap-1"><input type="radio" checked={scope === 'selected'} onChange={() => setScope('selected')} /> Selected domains</label>
        <label className="flex items-center gap-1"><input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} /> All sites</label>
      </div>
      {scope === 'all' && <p className="text-amber-600 dark:text-amber-400">All sites gives agents access to every signed-in site in this profile, including email, banking, and single sign-on. Import only the domains agents need.</p>}
      {scope === 'selected' && <>
        <Input aria-label="Domains" value={domains} onChange={event => setDomains(event.target.value)} placeholder="example.com, internal.company.com" />
        <p className="text-xs text-muted-foreground">A domain includes its subdomains.</p>
      </>}
      <div className="flex gap-2">
        <Button disabled={busy || !browserId || !profileId || (scope === 'selected' && !domains.split(',').some(domain => domain.trim()))} onClick={() => run(async () => {
          const selected = scope === 'all' ? [] : domains.split(',').map(domain => domain.trim()).filter(Boolean)
          setResult(await window.electronAPI.browser.importSessions({ browserId: browserId as BrowserImportSource['id'], profileId, domains: selected }))
        })}>Import browser sessions</Button>
        <Button variant="outline" disabled={busy} onClick={() => run(async () => { const removed = await window.electronAPI.browser.clearImportedSessions(); setResult(null); setMessage(`Agent browser storage cleared (${removed} cookies removed).`) })}>Clear all agent browser sessions</Button>
      </div>
      {message && <p role="status">{message}</p>}
      {result && <div role="status"><p>{result.imported} imported; {result.skipped} skipped.</p>{result.unsupportedWindowsCookies > 0 && <p>{result.unsupportedWindowsCookies} Windows app-bound (v20) cookies could not be imported. These cookies are protected for their original browser.</p>}<ul className="list-disc pl-5">{Object.entries(result.byDomain).sort(([a], [b]) => a.localeCompare(b)).map(([domain, count]) => <li key={domain}>{domain}: {count}</li>)}</ul></div>}
    </div>
  </SettingsSection>
}
