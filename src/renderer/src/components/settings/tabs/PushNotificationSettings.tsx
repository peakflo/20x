import { useEffect, useState } from 'react'
import { settingsApi, pushTest } from '@/lib/ipc-client'
import { DEFAULT_PUSH_PREFERENCES, parsePushPreferences, PUSH_EVENTS, type PushEvent, type PushPreferences } from '@shared/push-notifications'
import { Switch } from '@/components/ui/Switch'
import { Button } from '@/components/ui/Button'

const LABELS: Record<PushEvent, string> = {
  finished: 'Agent finishes', failed: 'Agent fails', approval: 'Agent needs approval', question: 'Agent asks a question'
}

export function PushNotificationSettings() {
  const [preferences, setPreferences] = useState<PushPreferences>(DEFAULT_PUSH_PREFERENCES)
  const [message, setMessage] = useState('')
  useEffect(() => { void settingsApi.get('mobile_push_preferences').then(value => setPreferences(parsePushPreferences(value ?? undefined))) }, [])

  const toggle = async (event: PushEvent) => {
    const next = { ...preferences, [event]: !preferences[event] }
    try {
      await settingsApi.set('mobile_push_preferences', JSON.stringify(next))
      setPreferences(next)
    } catch (error) { setMessage(String(error)) }
  }

  return <section className="space-y-3">
    <h3 className="font-medium">Phone push notifications</h3>
    <p className="text-xs text-muted-foreground">Pair your phone, open the HTTPS tunnel URL, then enable notifications in mobile Settings. Plain LAN HTTP does not support push. On iPhone, add the site to the Home Screen first. Re-enable after a tunnel URL change.</p>
    {PUSH_EVENTS.map(event => <div key={event} className="flex items-center justify-between"><span className="text-sm">{LABELS[event]}</span><Switch checked={preferences[event]} onCheckedChange={() => void toggle(event)} /></div>)}
    <Button variant="outline" onClick={() => void pushTest().then(() => setMessage('Test sent to subscribed phones.')).catch(error => setMessage(String(error)))}>Send test notification</Button>
    {message && <p className="text-xs text-muted-foreground">{message}</p>}
  </section>
}
