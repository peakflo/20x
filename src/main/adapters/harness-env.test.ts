import { describe, expect, it } from 'vitest'
import { buildHarnessBaseEnv, isKnownProviderCredentialVar, KNOWN_PROVIDER_CREDENTIAL_ENV_VARS } from './harness-env'

describe('buildHarnessBaseEnv', () => {
  const fakeSource = {
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    HTTP_PROXY: 'http://proxy:8080',
    HOME: '/Users/someone',
    ANTHROPIC_API_KEY: 'sk-ant-should-not-pass-through',
    OPENAI_API_KEY: 'sk-openai-should-not-pass-through',
    CODEX_API_KEY: 'sk-codex-should-not-pass-through',
    OPENCODE_API_KEY: 'oc-should-not-pass-through',
    CURSOR_AUTH_TOKEN: 'cursor-should-not-pass-through',
    PEAKFLO_AI_GATEWAY_API_KEY: 'gw-should-not-pass-through',
    SOME_OTHER_VAR: 'keep-me'
  }

  it('strips every known provider credential var', () => {
    const env = buildHarnessBaseEnv(fakeSource)
    for (const key of KNOWN_PROVIDER_CREDENTIAL_ENV_VARS) {
      expect(env[key]).toBeUndefined()
    }
  })

  it('keeps PATH, locale, proxy, and unrelated vars untouched', () => {
    const env = buildHarnessBaseEnv(fakeSource)
    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.LANG).toBe('en_US.UTF-8')
    expect(env.LC_ALL).toBe('en_US.UTF-8')
    expect(env.HTTP_PROXY).toBe('http://proxy:8080')
    expect(env.HOME).toBe('/Users/someone')
    expect(env.SOME_OTHER_VAR).toBe('keep-me')
  })

  it('drops undefined-valued entries', () => {
    const env = buildHarnessBaseEnv({ FOO: undefined as unknown as string, BAR: 'baz' })
    expect(env.FOO).toBeUndefined()
    expect(env.BAR).toBe('baz')
  })

  it('isKnownProviderCredentialVar recognizes the full denylist', () => {
    for (const key of KNOWN_PROVIDER_CREDENTIAL_ENV_VARS) {
      expect(isKnownProviderCredentialVar(key)).toBe(true)
    }
    expect(isKnownProviderCredentialVar('PATH')).toBe(false)
    expect(isKnownProviderCredentialVar('RANDOM_VAR')).toBe(false)
  })

  it('defaults to process.env when no source is given', () => {
    const prev = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-leaky'
    try {
      const env = buildHarnessBaseEnv()
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prev
    }
  })
})
