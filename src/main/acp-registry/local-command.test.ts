import { describe, expect, it, vi, beforeEach } from 'vitest'
import { buildLocalCommandSpawnArgs, validateLocalCommand } from './local-command'
import * as registryClient from './registry-client'

describe('validateLocalCommand', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects an empty executable', async () => {
    const result = await validateLocalCommand({ executable: '  ' })
    expect(result?.kind).toBe('empty-executable')
  })

  it('rejects a .cmd/.bat wrapper on Windows', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    const result = await validateLocalCommand({ executable: 'C:\\tools\\agent.cmd' })
    expect(result?.kind).toBe('windows-script-wrapper')
    vi.unstubAllGlobals()
  })

  it('accepts a PATH-resolvable command name', async () => {
    vi.spyOn(registryClient, 'commandExistsOnPath').mockResolvedValue(true)
    const result = await validateLocalCommand({ executable: 'my-acp-agent' })
    expect(result).toBeNull()
  })

  it('rejects a command name not found on PATH', async () => {
    vi.spyOn(registryClient, 'commandExistsOnPath').mockResolvedValue(false)
    const result = await validateLocalCommand({ executable: 'does-not-exist-anywhere' })
    expect(result?.kind).toBe('not-found')
  })
})

describe('buildLocalCommandSpawnArgs', () => {
  it('always sets shell:false and passes args/env through literally', () => {
    const spawnArgs = buildLocalCommandSpawnArgs({
      executable: '/usr/local/bin/my-agent',
      args: ['--flag', 'value; rm -rf /'],
      env: { FOO: 'bar' }
    })
    expect(spawnArgs.shell).toBe(false)
    expect(spawnArgs.command).toBe('/usr/local/bin/my-agent')
    expect(spawnArgs.args).toEqual(['--flag', 'value; rm -rf /'])
    expect(spawnArgs.env).toEqual({ FOO: 'bar' })
  })
})
