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

import { writeLocalMcpEnvWrapper, cleanupLocalMcpEnvFile, cleanupStaleLocalMcpEnvFiles } from './mcp-env-wrapper'
import { existsSync, mkdirSync } from 'fs'

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

  it('refuses an unexpected serverId (defense in depth against path construction)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    expect(() => writeLocalMcpEnvWrapper('../escape', 'node', [], { KEY: 'value123456' })).toThrow(/unexpected server id/)
    expect(() => writeLocalMcpEnvWrapper('has a space', 'node', [], { KEY: 'value123456' })).toThrow(/unexpected server id/)
  })
})

// Minor finding, re-review: env files were never deleted anywhere — neither
// per-session nor at startup — so a secret written once to this directory
// outlived its session indefinitely.
describe('cleanupLocalMcpEnvFile and cleanupStaleLocalMcpEnvFiles', () => {
  const realPlatform = process.platform

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'mcp-env-wrapper-cleanup-test-'))
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('cleanupLocalMcpEnvFile deletes the one server\'s env file and leaves others alone', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    writeLocalMcpEnvWrapper('server-a', 'node', [], { KEY: 'value123456' })
    writeLocalMcpEnvWrapper('server-b', 'node', [], { KEY: 'value123456' })
    const dir = join(userDataDir, 'mcp-env')
    expect(existsSync(join(dir, 'server-a.env.sh'))).toBe(true)
    expect(existsSync(join(dir, 'server-b.env.sh'))).toBe(true)

    cleanupLocalMcpEnvFile('server-a')
    expect(existsSync(join(dir, 'server-a.env.sh'))).toBe(false)
    expect(existsSync(join(dir, 'server-b.env.sh'))).toBe(true)
  })

  it('cleanupLocalMcpEnvFile ignores an unexpected serverId instead of touching the filesystem', () => {
    expect(() => cleanupLocalMcpEnvFile('../escape')).not.toThrow()
  })

  it('cleanupLocalMcpEnvFile is a no-op when the file never existed', () => {
    expect(() => cleanupLocalMcpEnvFile('never-existed')).not.toThrow()
  })

  it('cleanupStaleLocalMcpEnvFiles removes every leftover env file but keeps the shared loader script', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    writeLocalMcpEnvWrapper('server-a', 'node', [], { KEY: 'value123456' })
    writeLocalMcpEnvWrapper('server-b', 'node', [], { KEY: 'value123456' })
    const dir = join(userDataDir, 'mcp-env')
    expect(existsSync(join(dir, 'mcp-env-loader.sh'))).toBe(true)

    cleanupStaleLocalMcpEnvFiles()

    expect(existsSync(join(dir, 'server-a.env.sh'))).toBe(false)
    expect(existsSync(join(dir, 'server-b.env.sh'))).toBe(false)
    expect(existsSync(join(dir, 'mcp-env-loader.sh'))).toBe(true) // shared, not per-session — untouched
  })

  it('cleanupStaleLocalMcpEnvFiles is a no-op when the directory does not exist yet', () => {
    rmSync(join(userDataDir, 'mcp-env'), { recursive: true, force: true })
    expect(() => cleanupStaleLocalMcpEnvFiles()).not.toThrow()
  })
})

// Minor finding, re-review: rewriting the loader ONLY when the file is
// missing meant a fix to the loader's own source (e.g. the Windows
// arg-slicing fix in this same PR) would never reach a user whose app had
// already written an older version of the file once.
describe('ensureLoaderScript rewrites on content change, not just on missing', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'mcp-env-wrapper-rewrite-test-'))
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('rewrites a stale/modified loader script to the current content', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const dir = join(userDataDir, 'mcp-env')
    mkdirSync(dir, { recursive: true })
    const loaderPath = join(dir, 'mcp-env-loader.sh')
    writeFileSync(loaderPath, '#!/bin/bash\n# an old/stale version of the loader\necho stale\n', 'utf-8')

    writeLocalMcpEnvWrapper('server-a', 'node', [], { KEY: 'value123456' })

    const rewritten = readFileSync(loaderPath, 'utf-8')
    expect(rewritten).not.toContain('stale')
    expect(rewritten).toContain('#!/bin/bash')
  })
})
