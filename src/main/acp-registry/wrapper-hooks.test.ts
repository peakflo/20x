import { describe, expect, it, afterEach } from 'vitest'
import {
  getWrapperHooks,
  registerWrapperHooksForTests,
  unregisterWrapperHooksForTests,
  type AcpWrapperHooks
} from './wrapper-hooks'
import { devinHooks } from './wrappers/devin'
import { mistralVibeHooks } from './wrappers/mistral-vibe'

describe('getWrapperHooks', () => {
  it('returns an empty object for an agent with no registered wrapper', () => {
    expect(getWrapperHooks('some-unknown-agent')).toEqual({})
  })

  it('returns an empty object for a null/undefined id', () => {
    expect(getWrapperHooks(null)).toEqual({})
    expect(getWrapperHooks(undefined)).toEqual({})
  })

  it('resolves the devin wrapper by registry id', () => {
    expect(getWrapperHooks('devin')).toBe(devinHooks)
  })

  it('resolves the mistral-vibe wrapper by registry id', () => {
    expect(getWrapperHooks('mistral-vibe')).toBe(mistralVibeHooks)
  })

  it('supports registering a wrapper at runtime (for tests/extensibility)', () => {
    const hooks: AcpWrapperHooks = { mapModelIdToWire: (id) => `wire-${id}` }
    registerWrapperHooksForTests('test-only-agent', hooks)
    expect(getWrapperHooks('test-only-agent')).toBe(hooks)
    unregisterWrapperHooksForTests('test-only-agent')
    expect(getWrapperHooks('test-only-agent')).toEqual({})
  })
})

describe('devin wrapper hooks', () => {
  it('classifies a 429/rate-limit-worded error as rate-limit', () => {
    expect(devinHooks.classifyError?.(new Error('HTTP 429: too many requests'))).toBe('rate-limit')
    expect(devinHooks.classifyError?.('Rate limit exceeded, please slow down')).toBe('rate-limit')
  })

  it('classifies a usage/quota-worded error as usage-limit', () => {
    expect(devinHooks.classifyError?.(new Error('Monthly usage limit reached'))).toBe('usage-limit')
    expect(devinHooks.classifyError?.('quota exceeded for this account')).toBe('usage-limit')
  })

  it('does not misclassify an unrelated error', () => {
    expect(devinHooks.classifyError?.(new Error('Connection refused'))).toBeUndefined()
  })

  it('prefers env_var auth when the expected API key env var is present', () => {
    const chosen = devinHooks.preferredAuthMethod?.({
      availableMethods: ['agent', 'env_var'],
      hasEnvVar: (name) => name === 'DEVIN_API_KEY'
    })
    expect(chosen).toBe('env_var')
  })

  it('falls back to the first advertised method when no preferred env var is set', () => {
    const chosen = devinHooks.preferredAuthMethod?.({
      availableMethods: ['agent', 'terminal'],
      hasEnvVar: () => false
    })
    expect(chosen).toBe('agent')
  })
})

describe('mistral-vibe wrapper hooks', () => {
  it('reclassifies a rate_limited provider-retry notification as rate-limit', () => {
    const result = mistralVibeHooks.handleExtensionNotification?.('mistralVibe/providerRetry', { cause: 'rate_limited' })
    expect(result).toEqual({ retryClass: 'rate-limit' })
  })

  it('reclassifies any other cause as a generic transport retry', () => {
    const result = mistralVibeHooks.handleExtensionNotification?.('mistralVibe/providerRetry', { cause: 'timeout' })
    expect(result).toEqual({ retryClass: 'transport' })
  })

  it('ignores notifications for a different method', () => {
    const result = mistralVibeHooks.handleExtensionNotification?.('some/otherMethod', { cause: 'rate_limited' })
    expect(result).toBeUndefined()
  })
})

describe('hook dispatch is driven purely by registry agent id', () => {
  afterEach(() => unregisterWrapperHooksForTests('fake-local-agent'))

  it('applies the same wrapper whether the instance is registry-sourced or a local command matching the same id', () => {
    const hooks: AcpWrapperHooks = { classifyError: () => 'rate-limit' }
    registerWrapperHooksForTests('fake-local-agent', hooks)
    // A local-command instance that happens to declare the same registry id
    // (e.g. the user pointed a local build of a known agent) gets the same hooks.
    expect(getWrapperHooks('fake-local-agent')).toBe(hooks)
  })
})
