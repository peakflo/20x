import { describe, expect, it } from 'vitest'
import { SpacesArtifactCache, looksSecret } from './spaces-artifact-cache'

const entry = (key: string, content: string | null, taskId = 't1') => ({
  key, taskId, meta: { key }, content, encoding: (content === null ? 'none' : 'utf8') as 'utf8' | 'none', mimeType: 'text/markdown', sizeBytes: content?.length ?? 0
})

describe('SpacesArtifactCache', () => {
  it('evicts the least recently used entry past the entry cap', () => {
    const c = new SpacesArtifactCache({ maxEntries: 2 })
    c.put(entry('a', '1')); c.put(entry('b', '2'))
    c.get('a') // a is now the most recent
    c.put(entry('c', '3'))
    expect(c.get('b')).toBeUndefined()
    expect(c.get('a')).toBeDefined()
    expect(c.get('c')).toBeDefined()
  })

  it('evicts to stay under the byte cap', () => {
    const c = new SpacesArtifactCache({ maxBytes: 1200, maxEntries: 50 })
    for (let i = 0; i < 10; i++) c.put(entry(`k${i}`, 'x'.repeat(300)))
    expect(c.bytes).toBeLessThanOrEqual(1200)
    expect(c.get('k9')).toBeDefined()
    expect(c.get('k0')).toBeUndefined()
  })

  it('expires entries after the TTL', () => {
    let now = 1000
    const c = new SpacesArtifactCache({ ttlMs: 500, now: () => now })
    c.put(entry('a', 'x'))
    now += 400
    expect(c.get('a')).toBeDefined()
    now += 200
    expect(c.get('a')).toBeUndefined()
    expect(c.listForTask('t1')).toEqual([])
  })

  it('keeps metadata but never caches content that looks like a secret or is too large', () => {
    const c = new SpacesArtifactCache({ maxEntryBytes: 10 })
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk'
    expect(looksSecret(`token = ${jwt}`)).toBe(true)
    const withSecret = new SpacesArtifactCache().put(entry('s', `Authorization: Bearer ${jwt}`))
    expect(withSecret.content).toBeNull()
    expect(withSecret.encoding).toBe('none')
    expect(c.put(entry('big', 'x'.repeat(100))).content).toBeNull()
    expect(c.put(entry('ok', 'short')).content).toBe('short')
  })

  it('round-trips through snapshot/restore without expired entries', () => {
    let now = 0
    const a = new SpacesArtifactCache({ ttlMs: 100, now: () => now })
    a.put(entry('old', 'x')); now = 90; a.put(entry('new', 'y')); now = 150
    const b = new SpacesArtifactCache({ ttlMs: 100, now: () => now })
    b.restore(a.snapshot())
    expect(b.get('old')).toBeUndefined()
    expect(b.get('new')?.content).toBe('y')
  })
})
