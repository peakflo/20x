import { describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { buildPushPayload, pushEventForStatus } from '../shared/push-notifications'
import { sendMobilePush } from './mobile-push'
import { AgentPushEvents } from './agent-push-events'
import { isPushSubscription } from './mobile-push'

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
    const subscription = JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/one', keys: { p256dh: 'a', auth: 'b' } })
    db.setMobilePushSubscription('one', subscription)
    db.setMobilePushSubscription('two', JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/two', keys: { p256dh: 'a', auth: 'b' } }))
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

  it('moves a browser endpoint to a new paired session without duplicate delivery', async () => {
    const { db } = createTestDb()
    db.createMobileSession('old', 'old-hash', 'Phone')
    db.createMobileSession('new', 'new-hash', 'Phone')
    const subscription = JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/one', keys: { p256dh: 'a', auth: 'b' } })
    db.setMobilePushSubscription('old', subscription)
    db.setMobilePushSubscription('new', subscription)
    expect(db.getMobilePushSubscription('old')).toBeUndefined()
    expect(db.getMobilePushSubscriptions()).toHaveLength(1)
    expect(db.getMobilePushSubscriptions()[0].session_id).toBe('new')
    const sender = vi.fn(async (_subscription: unknown, _payload?: string | Buffer | null) => ({ statusCode: 201, body: '', headers: {} }))
    await sendMobilePush(db, 'finished', 'task', 'Task', sender)
    expect(sender).toHaveBeenCalledOnce()
  })

  it('sends one question for repeated tool updates and suppresses completion', async () => {
    const { db } = createTestDb()
    db.createMobileSession('phone', 'hash', 'Phone')
    db.setMobilePushSubscription('phone', JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/one', keys: { p256dh: 'a', auth: 'b' } }))
    const events = new AgentPushEvents()
    const sender = vi.fn(async (_subscription: unknown, _payload?: string | Buffer | null) => ({ statusCode: 201, body: '', headers: {} }))
    const question = { id: 'tool-1', partType: 'question', tool: { name: 'AskUserQuestion', status: 'pending' } }
    expect(events.questionStarted('session', question)).toBe(true)
    await sendMobilePush(db, 'question', 'task', 'Task', sender)
    expect(events.questionStarted('session', question)).toBe(false)
    expect(events.questionStarted('session', { ...question, update: true, tool: { ...question.tool, status: 'completed' } })).toBe(false)
    expect(events.statusChanged('session', 'working', 'working')).toBeNull()
    expect(events.statusChanged('session', 'working', 'idle')).toBeNull()
    expect(sender).toHaveBeenCalledOnce()
    expect(events.statusChanged('session', 'idle', 'working')).toBeNull()
    expect(events.questionStarted('session', { ...question, id: 'tool-2' })).toBe(true)
  })

  it('honors event toggles and removes expired endpoints', async () => {
    const { db } = createTestDb()
    db.createMobileSession('phone', 'phone-hash', 'Phone')
    db.setMobilePushSubscription('phone', JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/old', keys: { p256dh: 'a', auth: 'b' } }))
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

  it('bypasses event toggles for tests, applies a timeout, and reports expired subscriptions', async () => {
    const { db } = createTestDb()
    db.createMobileSession('phone', 'hash', 'Phone')
    db.setMobilePushSubscription('phone', JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/old', keys: { p256dh: 'a', auth: 'b' } }))
    db.setSetting('mobile_push_preferences', JSON.stringify({ finished: false }))
    const sender = vi.fn(async (_subscription: unknown, _payload?: string | Buffer | null, _options?: unknown): Promise<{ statusCode: number; body: string; headers: Record<string, string> }> => { throw { statusCode: 410 } })
    await expect(sendMobilePush(db, 'finished', '', 'Test', sender, { sessionId: 'phone', ignorePreferences: true, throwOnError: true })).rejects.toMatchObject({ status: 410 })
    expect(sender.mock.calls[0][2]).toEqual({ timeout: 10_000 })
    expect(db.getMobilePushSubscriptions()).toEqual([])
  })

  it('rejects arbitrary and local subscription destinations', () => {
    const keys = { p256dh: 'a', auth: 'b' }
    expect(isPushSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/id', keys })).toBe(true)
    expect(isPushSubscription({ endpoint: 'https://127.0.0.1/push', keys })).toBe(false)
    expect(isPushSubscription({ endpoint: 'http://fcm.googleapis.com/push', keys })).toBe(false)
    expect(isPushSubscription({ endpoint: 'https://example.com/push', keys })).toBe(false)
  })

  it('drops an unsafe legacy endpoint without contacting it', async () => {
    const { db } = createTestDb()
    db.createMobileSession('phone', 'hash', 'Phone')
    db.setMobilePushSubscription('phone', JSON.stringify({ endpoint: 'https://127.0.0.1/push', keys: { p256dh: 'a', auth: 'b' } }))
    const sender = vi.fn(async (_subscription: unknown, _payload?: string | Buffer | null) => ({ statusCode: 201, body: '', headers: {} }))
    await sendMobilePush(db, 'finished', 'task', 'Task', sender)
    expect(sender).not.toHaveBeenCalled()
    expect(db.getMobilePushSubscriptions()).toEqual([])
  })
})
