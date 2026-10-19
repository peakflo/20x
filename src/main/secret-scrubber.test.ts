import { describe, expect, it } from 'vitest'
import { SecretScrubber, isTrivialSecretValue, NOOP_SCRUBBER } from './secret-scrubber'

describe('SecretScrubber', () => {
  it('replaces a raw value with the named placeholder', () => {
    const s = new SecretScrubber([{ name: 'OPENAI_API_KEY', value: 'sk-verysecretvalue123' }])
    expect(s.scrub('the key is sk-verysecretvalue123 ok')).toBe('the key is «$OPENAI_API_KEY» ok')
  })

  it('falls back to the generic placeholder when the name is unknown', () => {
    const s = new SecretScrubber([{ value: 'sk-verysecretvalue123' }])
    expect(s.scrub('token=sk-verysecretvalue123')).toBe('token=«secret»')
  })

  it('matches base64-encoded form of the value', () => {
    const value = 'sk-verysecretvalue123'
    const s = new SecretScrubber([{ name: 'X', value }])
    const b64 = Buffer.from(value, 'utf8').toString('base64')
    expect(s.scrub(`encoded: ${b64}`)).toBe('encoded: «$X»')
  })

  it('matches base64url-encoded form of the value', () => {
    const value = 'sk-very/secret+value123=='
    const s = new SecretScrubber([{ name: 'X', value }])
    const b64url = Buffer.from(value, 'utf8').toString('base64url')
    expect(s.scrub(`encoded: ${b64url}`)).toBe('encoded: «$X»')
  })

  it('matches URL-encoded form of the value', () => {
    const value = 'sk-secret value/with+chars'
    const s = new SecretScrubber([{ name: 'X', value }])
    const encoded = encodeURIComponent(value)
    expect(s.scrub(`q=${encoded}`)).toBe('q=«$X»')
  })

  it('matches JSON-escaped form of the value', () => {
    const value = 'sk-secret"with\\quotes'
    const s = new SecretScrubber([{ name: 'X', value }])
    const jsonBody = JSON.stringify({ token: value })
    expect(s.scrub(jsonBody)).toBe('{"token":"«$X»"}')
  })

  it('redacts the value inside a Bearer header without a special case', () => {
    const value = 'sk-verysecretvalue123'
    const s = new SecretScrubber([{ name: 'TOKEN', value }])
    expect(s.scrub(`Authorization: Bearer ${value}`)).toBe('Authorization: Bearer «$TOKEN»')
  })

  it('scrubs every occurrence, including across multiple secrets', () => {
    const s = new SecretScrubber([
      { name: 'A', value: 'firstsecretvalue' },
      { name: 'B', value: 'secondsecretvalue' }
    ])
    const text = 'firstsecretvalue ... secondsecretvalue ... firstsecretvalue'
    expect(s.scrub(text)).toBe('«$A» ... «$B» ... «$A»')
  })

  it('prefers the longer match when one value is a substring of another', () => {
    const s = new SecretScrubber([
      { name: 'SHORT', value: 'abcdef123456' },
      { name: 'LONG', value: 'abcdef123456EXTRA789012' }
    ])
    expect(s.scrub('abcdef123456EXTRA789012')).toBe('«$LONG»')
  })

  it('skips values shorter than 6 characters', () => {
    const s = new SecretScrubber([{ name: 'SHORT', value: 'ab12' }])
    expect(s.isEmpty).toBe(true)
    expect(s.scrub('ab12 appears here')).toBe('ab12 appears here')
  })

  it('skips trivial values: all-digit, repeated char, whitespace', () => {
    expect(isTrivialSecretValue('123456789')).toBe(true)
    expect(isTrivialSecretValue('aaaaaaaaaa')).toBe(true)
    expect(isTrivialSecretValue('      ')).toBe(true)
    expect(isTrivialSecretValue('')).toBe(true)
    expect(isTrivialSecretValue('sk-real-secret-9f2a')).toBe(false)
  })

  it('ignores undefined/null/empty entry values', () => {
    const s = new SecretScrubber([{ name: 'A', value: undefined }, { name: 'B', value: null }, { name: 'C', value: '' }])
    expect(s.isEmpty).toBe(true)
  })

  it('dedupes identical values added twice (e.g. same key from two sources)', () => {
    const s = new SecretScrubber([
      { name: 'A', value: 'duplicatedsecretvalue' },
      { name: 'A', value: 'duplicatedsecretvalue' }
    ])
    expect(s.entryCount).toBe(1)
  })

  it('handles streamed-chunk reassembly: scrubbing only works once the full value is assembled', () => {
    const value = 'splitacrosschunksvalue'
    const s = new SecretScrubber([{ name: 'X', value }])
    const chunk1 = value.slice(0, 10)
    const chunk2 = value.slice(10)
    // Scrubbing each delta separately misses it (half the value isn't a match) —
    // this documents why callers must scrub at part-assembly time, not per-delta.
    expect(s.scrub(chunk1)).toBe(chunk1)
    expect(s.scrub(chunk2)).toBe(chunk2)
    // Scrubbing the assembled text does catch it.
    expect(s.scrub(chunk1 + chunk2)).toBe('«$X»')
  })

  it('scrubDeep redacts strings nested in objects/arrays without mutating the input', () => {
    const value = 'nestedsecretvalue123'
    const s = new SecretScrubber([{ name: 'X', value }])
    const input = { tool: { input: { command: `echo ${value}` }, output: [`result ${value}`, { nested: value }] } }
    const scrubbed = s.scrubDeep(input)
    expect(scrubbed).toEqual({
      tool: { input: { command: 'echo «$X»' }, output: ['result «$X»', { nested: '«$X»' }] }
    })
    expect(input.tool.input.command).toBe(`echo ${value}`) // original untouched
  })

  it('NOOP_SCRUBBER passes text through unchanged', () => {
    expect(NOOP_SCRUBBER.scrub('anything at all')).toBe('anything at all')
    expect(NOOP_SCRUBBER.isEmpty).toBe(true)
  })

  it('performs scrubbing on large output quickly', () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({ name: `VAR_${i}`, value: `secret-value-number-${i}-abcdefg` }))
    const s = new SecretScrubber(entries)
    const chunk = `some ordinary log line with secret-value-number-7-abcdefg embedded here\n`
    const big = chunk.repeat(20000) // ~1.4MB
    const start = Date.now()
    const result = s.scrub(big)
    const elapsed = Date.now() - start
    expect(result).toContain('«$VAR_7»')
    expect(result).not.toContain('secret-value-number-7-abcdefg')
    expect(elapsed).toBeLessThan(2000)
  })

  it('addEntries can extend a scrubber after construction', () => {
    const s = new SecretScrubber([{ name: 'A', value: 'initialsecretvalue' }])
    expect(s.scrub('laterseecretvalueadded')).toBe('laterseecretvalueadded')
    s.addEntries([{ name: 'B', value: 'laterseecretvalueadded' }])
    expect(s.scrub('laterseecretvalueadded')).toBe('«$B»')
  })
})
