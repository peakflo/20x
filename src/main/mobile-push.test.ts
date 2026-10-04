import { describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { buildPushPayload, pushEventForStatus } from '../shared/push-notifications'
import { sendMobilePush } from './mobile-push'

describe('mobile push', () => {
  it('maps only actionable run transitions', () => {
    expect(pushEventForStatus('working', 'idle')).toBe('finished')
    expect(pushEventForStatus('working', 'error')).toBe('failed')
    expect(pushEventForStatus('working', 'waiting_approval')).toBe('approval')
    expect(pushEventForStatus('idle', 'waiting_approval')).toBeNull()
    expect(pushEventForStatus('working', 'working')).toBeNull()
  })

  it('builds a short payload with a conversation route', () => {
    expect(buildPushPayload('question', 'task/one', 'Review deployment')).toEqual({
      title: 'Review deployment', body: 'Agent has a question for you.',
      url: '/?conversation=task%2Fone', tag: 'task-task/one-question'
    })
  })

  it('stores subscriptions by session, removes revoked sessions, and sends only to active devices', async () => {
    const { db } = createTestDb()
    db.createMobileSession('one', 'hash-one', 'Phone 1')
    db.createMobileSession('two', 'hash-two', 'Phone 2')
    const subscription = JSON.stringify({ endpoint: 'https://push.example.com/one', keys: { p256dh: 'a', auth: 'b' } })
    db.setMobilePushSubscription('one', subscription)
    db.setMobilePushSubscription('two', subscription)
    expect(db.getMobilePushSubscriptions()).toHaveLength(2)
    db.revokeMobileSession('one')
    expect(db.getMobilePushSubscriptions().map(row => row.session_id)).toEqual(['two'])
    const sender = vi.fn(async (_subscription: unknown, _payload?: string | Buffer | null) => ({ statusCode: 201, body: '', headers: {} }))
    await sendMobilePush(db, 'finished', 'task-1', 'Task title', sender)
    expect(sender).toHaveBeenCalledOnce()
    expect(db.getSetting('mobile_push_vapid_public')).toBeTruthy()
    expect(db.getSetting('mobile_push_vapid_private')).toBeTruthy()
    expect(JSON.parse(String(sender.mock.calls[0][1])).url).toBe('/?conversation=task-1')
    db.revokeAllMobileSessions()
    expect(db.getMobilePushSubscriptions()).toEqual([])
  })

  it('honors event toggles and removes expired endpoints', async () => {
    const { db } = createTestDb()
    db.createMobileSession('phone', 'phone-hash', 'Phone')
    db.setMobilePushSubscription('phone', JSON.stringify({ endpoint: 'https://push.example.com/old', keys: { p256dh: 'a', auth: 'b' } }))
    db.setSetting('mobile_push_preferences', JSON.stringify({ failed: false }))
    const sender = vi.fn(async (_subscription: unknown, _payload?: string | Buffer | null): Promise<{ statusCode: number; body: string; headers: Record<string, string> }> => {
      throw { statusCode: 410 }
    })
    await sendMobilePush(db, 'failed', 'task', 'Task', sender)
    expect(sender).not.toHaveBeenCalled()
    await sendMobilePush(db, 'finished', 'task', 'Task', sender)
    expect(sender).toHaveBeenCalledOnce()
    expect(db.getMobilePushSubscriptions()).toEqual([])
  })
})
