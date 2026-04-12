import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sanitizeEnvForChild, validateUrlNotLocal, redactSensitiveData } from './security-utils'

describe('security-utils', () => {
  describe('sanitizeEnvForChild', () => {
    const originalEnv = { ...process.env }

    beforeEach(() => {
      process.env._20X_SB_PORT = '12345'
      process.env._20X_SB_TOKEN = 'secret-uuid-token'
      process.env._20X_REAL_SHELL = '/bin/bash'
      process.env.PATH = '/usr/bin'
      process.env.HOME = '/home/test'
    })

    afterEach(() => {
      process.env = { ...originalEnv }
    })

    it('strips _20X_SB_PORT from child env', () => {
      const env = sanitizeEnvForChild()
      expect(env._20X_SB_PORT).toBeUndefined()
    })

    it('strips _20X_SB_TOKEN from child env', () => {
      const env = sanitizeEnvForChild()
      expect(env._20X_SB_TOKEN).toBeUndefined()
    })

    it('strips _20X_REAL_SHELL from child env', () => {
      const env = sanitizeEnvForChild()
      expect(env._20X_REAL_SHELL).toBeUndefined()
    })

    it('preserves non-sensitive env vars', () => {
      const env = sanitizeEnvForChild()
      expect(env.PATH).toBe('/usr/bin')
      expect(env.HOME).toBe('/home/test')
    })

    it('merges extra vars into result', () => {
      const env = sanitizeEnvForChild({ npm_config_yes: 'true', CUSTOM: 'value' })
      expect(env.npm_config_yes).toBe('true')
      expect(env.CUSTOM).toBe('value')
      // Still strips sensitive vars
      expect(env._20X_SB_PORT).toBeUndefined()
    })

    it('does not modify process.env', () => {
      sanitizeEnvForChild()
      expect(process.env._20X_SB_PORT).toBe('12345')
    })
  })

  describe('validateUrlNotLocal', () => {
    it('allows public URLs', () => {
      expect(validateUrlNotLocal('https://api.example.com/mcp')).toEqual({ safe: true })
      expect(validateUrlNotLocal('https://8.8.8.8/api')).toEqual({ safe: true })
    })

    it('blocks localhost', () => {
      const result = validateUrlNotLocal('http://localhost:3000/secrets')
      expect(result.safe).toBe(false)
      expect(result.reason).toContain('local')
    })

    it('blocks 127.0.0.1', () => {
      const result = validateUrlNotLocal('http://127.0.0.1:9999/secrets/export')
      expect(result.safe).toBe(false)
      expect(result.reason).toContain('local')
    })

    it('blocks ::1 (IPv6 loopback)', () => {
      const result = validateUrlNotLocal('http://[::1]:8080/api')
      expect(result.safe).toBe(false)
    })

    it('blocks 0.0.0.0', () => {
      const result = validateUrlNotLocal('http://0.0.0.0:8080/api')
      expect(result.safe).toBe(false)
    })

    it('blocks 10.x.x.x (RFC-1918)', () => {
      const result = validateUrlNotLocal('http://10.0.0.1:8080/api')
      expect(result.safe).toBe(false)
      expect(result.reason).toContain('private')
    })

    it('blocks 172.16.x.x (RFC-1918)', () => {
      const result = validateUrlNotLocal('http://172.16.0.5:3000/')
      expect(result.safe).toBe(false)
    })

    it('allows 172.15.x.x (not in private range)', () => {
      expect(validateUrlNotLocal('http://172.15.0.1:3000/')).toEqual({ safe: true })
    })

    it('blocks 192.168.x.x (RFC-1918)', () => {
      const result = validateUrlNotLocal('http://192.168.1.1/')
      expect(result.safe).toBe(false)
    })

    it('blocks 169.254.x.x (link-local)', () => {
      const result = validateUrlNotLocal('http://169.254.169.254/latest/meta-data/')
      expect(result.safe).toBe(false)
    })

    it('rejects invalid URLs', () => {
      const result = validateUrlNotLocal('not-a-url')
      expect(result.safe).toBe(false)
      expect(result.reason).toContain('Invalid URL')
    })

    it('blocks 127.x.x.x (full loopback range)', () => {
      const result = validateUrlNotLocal('http://127.0.0.2:8080/')
      expect(result.safe).toBe(false)
    })
  })

  describe('redactSensitiveData', () => {
    it('redacts API key patterns', () => {
      const input = 'Got api_key: sk-abc123def456ghi789jkl012'
      const result = redactSensitiveData(input)
      expect(result).not.toContain('sk-abc123')
      expect(result).toContain('[REDACTED]')
    })

    it('redacts bearer tokens', () => {
      const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc'
      const result = redactSensitiveData(input)
      expect(result).toContain('[REDACTED]')
    })

    it('redacts GitHub personal access tokens', () => {
      const input = 'token: ghp_ABCDEFghijKLMNOP1234567890abcdefGHIJ'
      const result = redactSensitiveData(input)
      expect(result).not.toContain('ghp_ABCDEF')
      expect(result).toContain('[REDACTED]')
    })

    it('preserves non-sensitive content', () => {
      const input = 'Tool returned: {"status": "ok", "count": 42}'
      const result = redactSensitiveData(input)
      expect(result).toBe(input)
    })

    it('redacts Stripe-style keys', () => {
      const input = 'sk-live-abcdef123456789012345678'
      const result = redactSensitiveData(input)
      expect(result).toContain('[REDACTED]')
    })

    it('handles empty string', () => {
      expect(redactSensitiveData('')).toBe('')
    })
  })
})
