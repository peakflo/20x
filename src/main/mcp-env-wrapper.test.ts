import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let userDataDir: string

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userDataDir)
  }
}))

import { writeLocalMcpEnvWrapper } from './mcp-env-wrapper'

describe('writeLocalMcpEnvWrapper', () => {
  const realPlatform = process.platform

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'mcp-env-wrapper-test-'))
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('returns the original command/args unchanged when there is no env to hide', () => {
    const result = writeLocalMcpEnvWrapper('server-1', 'node', ['server.js'], {})
    expect(result).toEqual({ command: 'node', args: ['server.js'] })
  })

  it('on posix, wraps the command in a loader and never puts the secret value in argv', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const result = writeLocalMcpEnvWrapper('server-1', 'node', ['server.js', '--flag'], { API_KEY: 'super-secret-value' })

    // No argv element contains the raw secret value.
    for (const arg of [result.command, ...result.args]) {
      expect(arg).not.toContain('super-secret-value')
    }
    // The original command/args are preserved, just appended after the env file path.
    expect(result.args).toEqual(expect.arrayContaining(['node', 'server.js', '--flag']))

    // The env file itself holds the value, is 0600, and the command references it by path.
    const envFileArg = result.args.find((a) => a !== 'node' && a !== 'server.js' && a !== '--flag')!
    const contents = readFileSync(envFileArg, 'utf-8')
    expect(contents).toContain("export API_KEY='super-secret-value'")
    const mode = statSync(envFileArg).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('escapes embedded single quotes in the value', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const result = writeLocalMcpEnvWrapper('server-2', 'node', [], { KEY: "it's a secret" })
    const envFileArg = result.args[0]
    const contents = readFileSync(envFileArg, 'utf-8')
    expect(contents).toContain(`export KEY='it'\\''s a secret'`)
  })

  it('the loader script itself prints nothing and never enables -x', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const result = writeLocalMcpEnvWrapper('server-3', 'node', [], { KEY: 'value123456' })
    const loaderSource = readFileSync(result.command, 'utf-8')
    expect(loaderSource).not.toMatch(/\becho\b/)
    expect(loaderSource).not.toMatch(/set -x/)
    expect(loaderSource).not.toContain('printf')
  })

  it('overwrites the env file on repeated calls for the same serverId (secret rotation)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const first = writeLocalMcpEnvWrapper('server-4', 'node', [], { KEY: 'old-value-123' })
    const envFileArg = first.args[0]
    expect(readFileSync(envFileArg, 'utf-8')).toContain('old-value-123')

    const second = writeLocalMcpEnvWrapper('server-4', 'node', [], { KEY: 'new-value-456' })
    expect(second.args[0]).toBe(envFileArg)
    const contents = readFileSync(envFileArg, 'utf-8')
    expect(contents).toContain('new-value-456')
    expect(contents).not.toContain('old-value-123')
  })

  it('on windows, uses powershell with the env file path, not the value, in argv', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const result = writeLocalMcpEnvWrapper('server-5', 'node.exe', ['server.js'], { API_KEY: 'windows-secret-value' })
    expect(result.command).toBe('powershell.exe')
    for (const arg of result.args) {
      expect(arg).not.toContain('windows-secret-value')
    }
    const envFileArg = result.args.find((a) => a.endsWith('.env.txt'))!
    expect(readFileSync(envFileArg, 'utf-8')).toContain('API_KEY=windows-secret-value')
  })
})
