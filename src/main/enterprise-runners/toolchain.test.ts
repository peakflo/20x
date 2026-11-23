import { describe, expect, it } from 'vitest'
import { absolutePathDirs, resolveExecutable, resolveToolchain } from './toolchain'

describe('toolchain', () => {
  it('keeps only absolute PATH entries', () => {
    expect(absolutePathDirs(':.:bin:/usr/bin::./node_modules/.bin:/opt/homebrew/bin')).toEqual(['/usr/bin', '/opt/homebrew/bin'])
    expect(absolutePathDirs(undefined)).toEqual([])
  })

  it('never resolves from a relative entry', () => {
    const exe = (p: string) => p === 'node_modules/.bin/npx' || p === '/usr/bin/npx'
    expect(resolveExecutable('npx', absolutePathDirs('node_modules/.bin:/usr/bin'), exe)).toBe('/usr/bin/npx')
    expect(resolveExecutable('npx', absolutePathDirs('node_modules/.bin'), exe)).toBeNull()
  })

  it('prefers the npx next to the resolved node', () => {
    const present = new Set(['/a/bin/node', '/a/bin/npx', '/b/bin/npx', '/usr/bin/git'])
    const tools = resolveToolchain({ PATH: '/b/bin:/a/bin:/usr/bin' }, (p) => present.has(p))
    expect(tools).toMatchObject({ node: '/a/bin/node', npx: '/a/bin/npx', git: '/usr/bin/git' })
  })

  it('falls back to another npx on PATH, and reports a missing one', () => {
    expect(resolveToolchain({ PATH: '/a/bin:/b/bin' }, (p) => ['/a/bin/node', '/b/bin/npx'].includes(p)).npx).toBe('/b/bin/npx')
    expect(resolveToolchain({ PATH: '/a/bin' }, (p) => p === '/a/bin/node').npx).toBeNull()
  })
})
