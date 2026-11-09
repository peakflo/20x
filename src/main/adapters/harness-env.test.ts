import { describe, expect, it, vi } from 'vitest'
import {
  buildHarnessBaseEnv,
  isKnownProviderCredentialVar,
  KNOWN_PROVIDER_CREDENTIAL_ENV_VARS,
  reAddAmbientCredentials,
  applyShellCredentialsOptIn
} from './harness-env'

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

  it('strips GH_TOKEN/GITHUB_TOKEN and the AWS credential triad, but keeps AWS_PROFILE/AWS_REGION', () => {
    const env = buildHarnessBaseEnv({
      GH_TOKEN: 'gh-leak',
      GITHUB_TOKEN: 'gh-leak-2',
      // AWS_ACCESS_KEY_ID found missing from the denylist while testing the
      // round-3 re-review's Bedrock-gating fix: it doesn't match
      // CREDENTIAL_SUFFIX_RE (ends in "_ID", not "_ACCESS_KEY"/"_TOKEN"),
      // so it passed through to every harness unconditionally until it was
      // added to the explicit KNOWN_PROVIDER_CREDENTIAL_ENV_VARS list.
      AWS_ACCESS_KEY_ID: 'aws-leak-id',
      AWS_BEARER_TOKEN_BEDROCK: 'aws-leak-bedrock',
      AWS_SECRET_ACCESS_KEY: 'aws-leak',
      AWS_SESSION_TOKEN: 'aws-leak-2',
      AWS_PROFILE: 'default',
      AWS_REGION: 'us-east-1',
      AWS_DEFAULT_REGION: 'us-east-1'
    })
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined()
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined()
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

describe('reAddAmbientCredentials', () => {
  it('re-adds only the named vars that are actually present in the source, and registers each with the scrubber', () => {
    const env: Record<string, string> = {}
    const scrubber = { addEntries: vi.fn() }
    const source = { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-value', NOT_REQUESTED: 'should-not-appear' }
    reAddAmbientCredentials(env, ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'], scrubber, source)
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token-value')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined() // not present in source
    expect(env.NOT_REQUESTED).toBeUndefined() // not in the requested names list
    expect(scrubber.addEntries).toHaveBeenCalledWith([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'oauth-token-value' }])
    expect(scrubber.addEntries).toHaveBeenCalledTimes(1)
  })

  it('works with no scrubber provided (no-op registration, value still re-added)', () => {
    const env: Record<string, string> = {}
    reAddAmbientCredentials(env, ['AWS_BEARER_TOKEN_BEDROCK'], undefined, { AWS_BEARER_TOKEN_BEDROCK: 'bedrock-token' })
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe('bedrock-token')
  })
})

describe('applyShellCredentialsOptIn', () => {
  const source = {
    GH_TOKEN: 'gh-token-value',
    AWS_SECRET_ACCESS_KEY: 'aws-secret-value',
    PATH: '/usr/bin',
    SOME_UNRELATED_VAR: 'keep-me'
  }

  it('does nothing when not allowed (the safer default)', () => {
    const env: Record<string, string> = {}
    const scrubber = { addEntries: vi.fn() }
    applyShellCredentialsOptIn(env, false, scrubber, source)
    applyShellCredentialsOptIn(env, undefined, scrubber, source)
    expect(env).toEqual({})
    expect(scrubber.addEntries).not.toHaveBeenCalled()
  })

  it('re-adds every credential-shaped var from the source when allowed, registering each with the scrubber, and leaves non-credential vars alone', () => {
    const env: Record<string, string> = {}
    const scrubber = { addEntries: vi.fn() }
    applyShellCredentialsOptIn(env, true, scrubber, source)
    expect(env.GH_TOKEN).toBe('gh-token-value')
    expect(env.AWS_SECRET_ACCESS_KEY).toBe('aws-secret-value')
    expect(env.PATH).toBeUndefined() // not credential-shaped — this function doesn't touch it
    expect(env.SOME_UNRELATED_VAR).toBeUndefined()
    expect(scrubber.addEntries).toHaveBeenCalledWith([{ name: 'GH_TOKEN', value: 'gh-token-value' }])
    expect(scrubber.addEntries).toHaveBeenCalledWith([{ name: 'AWS_SECRET_ACCESS_KEY', value: 'aws-secret-value' }])
  })
})
