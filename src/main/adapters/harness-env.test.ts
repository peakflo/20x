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

  it('strips credential-shaped vars by pattern even when not explicitly named', () => {
    // These are NOT in KNOWN_PROVIDER_CREDENTIAL_ENV_VARS's historical set but
    // match the generic *_API_KEY / *_TOKEN / *_SECRET / *_PASSWORD suffix
    // pattern — a new provider 20x hasn't added a named constant for yet.
    const env = buildHarnessBaseEnv({
      SOME_NEW_VENDOR_API_KEY: 'leak-1',
      CI_REGISTRY_TOKEN: 'leak-2',
      DB_PASSWORD: 'leak-3',
      STRIPE_SECRET_KEY: 'leak-4',
      OAUTH_CLIENT_SECRET: 'leak-5',
      KEEP_ME: 'fine'
    })
    expect(env.SOME_NEW_VENDOR_API_KEY).toBeUndefined()
    expect(env.CI_REGISTRY_TOKEN).toBeUndefined()
    expect(env.DB_PASSWORD).toBeUndefined()
    expect(env.STRIPE_SECRET_KEY).toBeUndefined()
    expect(env.OAUTH_CLIENT_SECRET).toBeUndefined()
    expect(env.KEEP_ME).toBe('fine')
  })

  it('strips GH_TOKEN/GITHUB_TOKEN and AWS_SECRET_ACCESS_KEY/AWS_SESSION_TOKEN, but keeps AWS_PROFILE/AWS_REGION', () => {
    const env = buildHarnessBaseEnv({
      GH_TOKEN: 'gh-leak',
      GITHUB_TOKEN: 'gh-leak-2',
      AWS_SECRET_ACCESS_KEY: 'aws-leak',
      AWS_SESSION_TOKEN: 'aws-leak-2',
      AWS_PROFILE: 'default',
      AWS_REGION: 'us-east-1',
      AWS_DEFAULT_REGION: 'us-east-1'
    })
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.AWS_SESSION_TOKEN).toBeUndefined()
    expect(env.AWS_PROFILE).toBe('default')
    expect(env.AWS_REGION).toBe('us-east-1')
    expect(env.AWS_DEFAULT_REGION).toBe('us-east-1')
  })

  it('keeps SSH_AUTH_SOCK, NODE_EXTRA_CA_CERTS, and NO_PROXY/ALL_PROXY variants', () => {
    const env = buildHarnessBaseEnv({
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/custom-ca.pem',
      NO_PROXY: 'localhost',
      no_proxy: 'localhost',
      ALL_PROXY: 'socks5://127.0.0.1:1080',
      HTTPS_PROXY: 'https://proxy:8443'
    })
    expect(env.SSH_AUTH_SOCK).toBe('/tmp/ssh-agent.sock')
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/custom-ca.pem')
    expect(env.NO_PROXY).toBe('localhost')
    expect(env.no_proxy).toBe('localhost')
    expect(env.ALL_PROXY).toBe('socks5://127.0.0.1:1080')
    expect(env.HTTPS_PROXY).toBe('https://proxy:8443')
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
