import { describe, expect, it } from 'vitest'
import { DEFAULT_FOLLOWUP_ACTION, resolveFollowupAction } from './message-queue'

describe('resolveFollowupAction', () => {
  it('sends now by default and queues with the alternate shortcut', () => {
    expect(resolveFollowupAction(DEFAULT_FOLLOWUP_ACTION, true)).toBe('steer')
    expect(resolveFollowupAction(DEFAULT_FOLLOWUP_ACTION, true, true)).toBe('queue')
  })
  it('uses the saved default and reverses it for the modifier shortcut', () => {
    expect(resolveFollowupAction('queue', true)).toBe('queue')
    expect(resolveFollowupAction('queue', true, true)).toBe('steer')
    expect(resolveFollowupAction('steer', true)).toBe('steer')
    expect(resolveFollowupAction('steer', true, true)).toBe('queue')
  })

  it('queues for an agent without active steering', () => {
    expect(resolveFollowupAction('steer', false)).toBe('queue')
    expect(resolveFollowupAction('queue', false, true)).toBe('queue')
  })
})
