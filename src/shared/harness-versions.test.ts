import { describe, expect, it } from 'vitest'
import { HARNESS_KEYS, HARNESS_NPM_PACKAGES, isHarnessKey, resolveNpmPackageName } from './harness-versions'

describe('isHarnessKey', () => {
  it('accepts every known harness key', () => {
    for (const key of HARNESS_KEYS) expect(isHarnessKey(key)).toBe(true)
  })

  it('rejects unknown values', () => {
    expect(isHarnessKey('something-else')).toBe(false)
    expect(isHarnessKey(null)).toBe(false)
    expect(isHarnessKey(undefined)).toBe(false)
  })
})

describe('resolveNpmPackageName', () => {
  it('returns the fixed package for non-OpenCode harnesses', () => {
    expect(resolveNpmPackageName('claude-code', null)).toBe(HARNESS_NPM_PACKAGES['claude-code'])
    expect(resolveNpmPackageName('codex', '0.1.0')).toBe(HARNESS_NPM_PACKAGES.codex)
    expect(resolveNpmPackageName('pi', '0.80.5')).toBe(HARNESS_NPM_PACKAGES.pi)
  })

  it('returns null for Cursor (no npm package — it updates with 20x)', () => {
    expect(resolveNpmPackageName('cursor', '1.0.0')).toBeNull()
  })

  it('keeps an OpenCode 1.x install on the 1.x package', () => {
    expect(resolveNpmPackageName('opencode', '1.18.33')).toBe('opencode-ai')
    expect(resolveNpmPackageName('opencode', null)).toBe('opencode-ai')
    expect(resolveNpmPackageName('opencode', '0.5.0')).toBe('opencode-ai')
  })

  it('moves an OpenCode 2.x install onto the 2.x package, never crossing the boundary automatically', () => {
    expect(resolveNpmPackageName('opencode', '2.0.0')).toBe('@opencode/cli')
    expect(resolveNpmPackageName('opencode', '2.5.1')).toBe('@opencode/cli')
  })
})
