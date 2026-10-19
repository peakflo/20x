import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'

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
    const contents = readFileSync(envFileArg, 'utf-8')
    // The raw value never appears in the file — it's base64-encoded so the
    // loader never has to guess a text encoding and embedded newlines in a
    // multi-line secret (a PEM key) survive the round trip.
    expect(contents).not.toContain('windows-secret-value')
    expect(contents).toContain(`API_KEY=${Buffer.from('windows-secret-value', 'utf-8').toString('base64')}`)
  })

  it('on windows, base64-encoding preserves a multi-line secret (e.g. a PEM key) exactly', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIBogIBAAJBAKp\nmoretext==\n-----END PRIVATE KEY-----\n'
    const result = writeLocalMcpEnvWrapper('server-pem', 'node.exe', [], { PEM_KEY: pem })
    const envFileArg = result.args.find((a) => a.endsWith('.env.txt'))!
    const line = readFileSync(envFileArg, 'utf-8').split('\n').find((l) => l.startsWith('PEM_KEY='))!
    const encoded = line.slice('PEM_KEY='.length)
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8')
    expect(decoded).toBe(pem)
  })

  it("the PowerShell loader source doesn't contain the broken descending-range slice bug and splats args", () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const result = writeLocalMcpEnvWrapper('server-6', 'node.exe', ['server.js'], { KEY: 'v' })
    const wrapperPath = result.args.find((a) => a.endsWith('.ps1'))!
    const source = readFileSync(wrapperPath, 'utf-8')
    // The original bug: "$rest[1..0]" silently selects an out-of-bounds index
    // plus a duplicate of the command whenever there are zero trailing args.
    expect(source).not.toContain('$rest[1..0]')
    expect(source).not.toContain('$rest[1..($rest.Count - 1)]\n& $rest[0] $rest[1..($rest.Count - 1)]')
    // Splatting (@) rather than passing a bare array variable as one argument.
    expect(source).toMatch(/& \$cmd @\$?cmdArgs|& \$cmd @\(/)
  })

  it('skips env entries whose key is not a valid env-var name, on both posix and windows', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const posixResult = writeLocalMcpEnvWrapper('server-7', 'node', [], {
      GOOD_KEY: 'keep-me',
      'BAD KEY': 'drop-me',
      'BAD=KEY': 'drop-me-too'
    })
    const posixEnvFile = posixResult.args[0]
    const posixContents = readFileSync(posixEnvFile, 'utf-8')
    expect(posixContents).toContain('GOOD_KEY')
    expect(posixContents).not.toContain('drop-me')
    expect(posixContents).not.toContain('drop-me-too')

    Object.defineProperty(process, 'platform', { value: 'win32' })
    const winResult = writeLocalMcpEnvWrapper('server-8', 'node.exe', [], {
      GOOD_KEY: 'keep-me-2',
      'BAD KEY': 'drop-me-2'
    })
    const winEnvFile = winResult.args.find((a) => a.endsWith('.env.txt'))!
    const winContents = readFileSync(winEnvFile, 'utf-8')
    expect(winContents).toContain('GOOD_KEY')
    expect(winContents).not.toContain(Buffer.from('drop-me-2', 'utf-8').toString('base64'))
  })

  it('end-to-end on posix: spawning the wrapped command actually delivers the secret to the child env, never via argv', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const stubServerPath = join(userDataDir, 'stub-server.js')
    writeFileSync(stubServerPath, "process.stdout.write(String(process.env.STUB_SECRET || ''))\n", 'utf-8')

    const result = writeLocalMcpEnvWrapper('server-e2e', process.execPath, [stubServerPath], {
      STUB_SECRET: 'end-to-end-secret-value'
    })

    // Not in argv anywhere.
    for (const arg of [result.command, ...result.args]) {
      expect(arg).not.toContain('end-to-end-secret-value')
    }

    // But the spawned child actually receives it via the sourced env file.
    const output = execFileSync(result.command, result.args, { encoding: 'utf-8' })
    expect(output).toBe('end-to-end-secret-value')
  })
})
