import webpush from 'web-push'
import type { DatabaseManager } from './database'
import { buildPushPayload, parsePushPreferences, type PushEvent } from '../shared/push-notifications'

export const PUSH_PREFERENCES_KEY = 'mobile_push_preferences'

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
  if (typeof subscription.endpoint !== 'string' || !/^https:\/\//.test(subscription.endpoint)) return false
  if (!subscription.keys || typeof subscription.keys.p256dh !== 'string' || typeof subscription.keys.auth !== 'string') return false
  return subscription.keys.p256dh.length > 0 && subscription.keys.auth.length > 0
}

export async function sendMobilePush(db: DatabaseManager, event: PushEvent, taskId: string, taskTitle: string,
  sender: typeof webpush.sendNotification = webpush.sendNotification): Promise<void> {
  if (!parsePushPreferences(db.getSetting(PUSH_PREFERENCES_KEY))[event]) return
  const subscriptions = db.getMobilePushSubscriptions()
  if (subscriptions.length === 0) return
  const publicKey = getVapidPublicKey(db)
  webpush.setVapidDetails('mailto:notifications@20x.app', publicKey, db.getSetting('mobile_push_vapid_private')!)
  const payload = JSON.stringify(buildPushPayload(event, taskId, taskTitle))
  await Promise.all(subscriptions.map(async ({ session_id, subscription }) => {
    try {
      await sender(JSON.parse(subscription) as webpush.PushSubscription, payload)
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode
      if (status === 404 || status === 410) db.setMobilePushSubscription(session_id, null)
      else console.error('[MobilePush] Delivery failed:', error)
    }
  }))
}
