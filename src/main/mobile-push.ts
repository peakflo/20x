import webpush from 'web-push'
import type { DatabaseManager } from './database'
import { buildPushPayload, parsePushPreferences, type PushEvent } from '../shared/push-notifications'

export const PUSH_PREFERENCES_KEY = 'mobile_push_preferences'
const PUSH_SEND_TIMEOUT_MS = 10_000

export interface PushSendOptions {
  sessionId?: string
  ignorePreferences?: boolean
  throwOnError?: boolean
}

export function getVapidPublicKey(db: DatabaseManager): string {
  let publicKey = db.getSetting('mobile_push_vapid_public')
  let privateKey = db.getSetting('mobile_push_vapid_private')
  if (!publicKey || !privateKey) {
    const keys = webpush.generateVAPIDKeys()
    publicKey = keys.publicKey
    privateKey = keys.privateKey
    db.setSetting('mobile_push_vapid_public', publicKey)
    db.setSetting('mobile_push_vapid_private', privateKey)
  }
  return publicKey
}

export function isPushSubscription(value: unknown): value is webpush.PushSubscription {
  if (!value || typeof value !== 'object') return false
  const subscription = value as Partial<webpush.PushSubscription>
  if (typeof subscription.endpoint !== 'string') return false
  let url: URL
  try { url = new URL(subscription.endpoint) } catch { return false }
  const host = url.hostname.toLowerCase()
  const knownService = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' ||
    host === 'web.push.apple.com' || host.endsWith('.push.apple.com') || host.endsWith('.notify.windows.com')
  if (url.protocol !== 'https:' || !knownService || url.username || url.password || !url.pathname.startsWith('/')) return false
  if (!subscription.keys || typeof subscription.keys.p256dh !== 'string' || typeof subscription.keys.auth !== 'string') return false
  return subscription.keys.p256dh.length > 0 && subscription.keys.auth.length > 0
}

export async function sendMobilePush(db: DatabaseManager, event: PushEvent, taskId: string, taskTitle: string,
  sender: typeof webpush.sendNotification = webpush.sendNotification, options: PushSendOptions = {}): Promise<{ sent: number; failed: number }> {
  if (!options.ignorePreferences && !parsePushPreferences(db.getSetting(PUSH_PREFERENCES_KEY))[event]) return { sent: 0, failed: 0 }
  const subscriptions = db.getMobilePushSubscriptions().filter(row => !options.sessionId || row.session_id === options.sessionId)
  if (subscriptions.length === 0) return { sent: 0, failed: 0 }
  const publicKey = getVapidPublicKey(db)
  webpush.setVapidDetails('mailto:notifications@20x.app', publicKey, db.getSetting('mobile_push_vapid_private')!)
  const payload = JSON.stringify(buildPushPayload(event, taskId, taskTitle))
  let sent = 0
  let failed = 0
  await Promise.all(subscriptions.map(async ({ session_id, subscription }) => {
    try {
      const parsed = JSON.parse(subscription) as webpush.PushSubscription
      if (!isPushSubscription(parsed)) {
        throw Object.assign(new Error('Invalid stored push subscription'), { statusCode: 410 })
      }
      await sender(parsed, payload, { timeout: PUSH_SEND_TIMEOUT_MS })
      sent++
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode
      if (status === 404 || status === 410) db.setMobilePushSubscription(session_id, null)
      failed++
      if (options.throwOnError) {
        throw Object.assign(new Error(status === 404 || status === 410 ? 'Push subscription expired' : 'Push delivery failed'), { status: status === 404 || status === 410 ? 410 : 502 })
      }
      console.error('[MobilePush] Delivery failed:', error)
    }
  }))
  return { sent, failed }
}
