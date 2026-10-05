import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { DEFAULT_PUSH_PREFERENCES, PUSH_EVENTS, type PushEvent, type PushPreferences } from '@shared/push-notifications'

const LABELS: Record<PushEvent, string> = {
  finished: 'Agent finishes', failed: 'Agent fails', approval: 'Agent needs approval', question: 'Agent asks a question'
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const raw = atob((base64 + '='.repeat((4 - base64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, char => char.charCodeAt(0))
}

export function PushSettings() {
  const [preferences, setPreferences] = useState<PushPreferences>(DEFAULT_PUSH_PREFERENCES)
  const [subscribed, setSubscribed] = useState(false)
  const [message, setMessage] = useState('')
  const supported = typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

  useEffect(() => {
    void api.push.config().then(config => setPreferences(config.preferences)).catch(error => setMessage(String(error)))
    if (supported) void navigator.serviceWorker.register('/push-sw.js').then(async registration => {
      const browserSubscription = await registration.pushManager.getSubscription()
      const serverSubscription = (await api.push.subscription()).subscription
      if (browserSubscription && browserSubscription.endpoint !== serverSubscription?.endpoint) {
        await api.push.subscribe(browserSubscription.toJSON())
      } else if (!browserSubscription && serverSubscription) {
        await api.push.subscribe(null)
      }
      setSubscribed(Boolean(browserSubscription))
    }).catch(error => setMessage(String(error)))
  }, [supported])

  const enable = async () => {
    try {
      if (Notification.permission !== 'granted' && await Notification.requestPermission() !== 'granted') {
        setMessage('Notification permission was not granted.')
        return
      }
      const registration = await navigator.serviceWorker.register('/push-sw.js')
      const config = await api.push.config()
      const subscription = await registration.pushManager.getSubscription() ??
        await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(config.publicKey) })
      await api.push.subscribe(subscription.toJSON())
      setSubscribed(true)
      setMessage('Notifications enabled on this device.')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }

  const disable = async () => {
    try {
      const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription()
      await api.push.subscribe(null)
      await subscription?.unsubscribe()
      setSubscribed(false)
      setMessage('Notifications disabled on this device.')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }

  const toggle = async (event: PushEvent) => {
    const next = { ...preferences, [event]: !preferences[event] }
    try { setPreferences((await api.push.preferences(next)).preferences) }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }

  return <section className="space-y-3">
    <h2 className="text-sm font-semibold">Phone notifications</h2>
    <p className="text-xs text-muted-foreground">The event choices below apply to every paired phone. Device enrollment is separate.</p>
    <p className="text-xs text-muted-foreground">Push requires HTTPS. Open the tunnel URL from desktop Settings; plain LAN HTTP does not support push. If the tunnel URL changes, enable notifications again at the new address.</p>
    {!supported && <p className="text-xs text-amber-400">Push is unavailable here. On iPhone, open the HTTPS link in Safari, choose Share → Add to Home Screen, then open the installed app. iOS 16.4 or later is required.</p>}
    {supported && <button className="text-sm text-primary" onClick={subscribed ? disable : enable}>{subscribed ? 'Disable on this device' : 'Enable on this device'}</button>}
    {PUSH_EVENTS.map(event => <label key={event} className="flex items-center justify-between text-sm"><span>{LABELS[event]}</span><input type="checkbox" checked={preferences[event]} onChange={() => void toggle(event)} /></label>)}
    {subscribed && <button className="text-sm text-primary" onClick={() => void api.push.test().then(() => setMessage('Test sent.')).catch(error => setMessage(String(error)))}>Send test notification</button>}
    {message && <p className="text-xs text-muted-foreground">{message}</p>}
  </section>
}
