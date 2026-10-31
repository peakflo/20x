import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildFallbackPath,
  buildShellEnvCommand,
  getNvmDefaultBin,
  parseShellEnvOutput,
  readShellEnv,
  resolveNvmAlias,
  type ShellRunResult
} from './shell-env'

let home: string
let nvmDir: string

function makeNvm(versions: string[], aliases: Record<string, string> = {}): void {
  for (const v of versions) mkdirSync(join(nvmDir, 'versions', 'node', v, 'bin'), { recursive: true })
  for (const [name, target] of Object.entries(aliases)) {
    const file = join(nvmDir, 'alias', name)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, `${target}\n`)
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), '20x-shell-env-'))
  nvmDir = join(home, '.nvm')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('resolveNvmAlias / getNvmDefaultBin', () => {
  it('resolves a major-version prefix to the newest matching install', () => {
    makeNvm(['v20.17.0', 'v22.9.0', 'v22.14.0', 'v24.1.0'], { default: '22' })
    expect(getNvmDefaultBin(home, nvmDir)).toBe(join(nvmDir, 'versions', 'node', 'v22.14.0', 'bin'))
  })

  it('resolves exact versions, node/stable and chained lts aliases', () => {
    makeNvm(['v20.17.0', 'v22.14.0', 'v24.1.0'], { 'lts/*': 'lts/jod', 'lts/jod': 'v22.14.0', work: 'lts/*' })
    expect(resolveNvmAlias(nvmDir, 'v20.17.0')).toBe('v20.17.0')
    expect(resolveNvmAlias(nvmDir, 'node')).toBe('v24.1.0')
    expect(resolveNvmAlias(nvmDir, 'stable')).toBe('v24.1.0')
    expect(resolveNvmAlias(nvmDir, 'lts/*')).toBe('v22.14.0')
    expect(resolveNvmAlias(nvmDir, 'work')).toBe('v22.14.0')
    expect(resolveNvmAlias(nvmDir, '22.1')).toBeNull()
    expect(resolveNvmAlias(nvmDir, 'system')).toBeNull()
  })

  it('does not loop on self-referencing aliases', () => {
    makeNvm(['v22.14.0'], { a: 'b', b: 'a' })
    expect(resolveNvmAlias(nvmDir, 'a')).toBeNull()
  })

  it('returns null without an alias/default file', () => {
    makeNvm(['v22.14.0'])
    expect(getNvmDefaultBin(home, nvmDir)).toBeNull()
  })
})

describe('buildFallbackPath', () => {
  it('orders version managers, then user bins, then Homebrew/system, and keeps only existing dirs', () => {
    makeNvm(['v22.14.0', 'v24.1.0'], { default: '22' })
    for (const d of ['.volta/bin', '.local/bin', '.bun/bin', '.cargo/bin']) mkdirSync(join(home, d), { recursive: true })
    const systemDirs = new Set(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])
    const exists = (dir: string): boolean => systemDirs.has(dir) || (dir.startsWith(home) && existsSync(dir))

    const parts = buildFallbackPath({ home, nvmDir, existingPath: '/usr/bin:/custom/bin', exists }).split(':')

    expect(parts).toEqual([
      join(nvmDir, 'versions', 'node', 'v22.14.0', 'bin'),
      join(nvmDir, 'versions', 'node', 'v24.1.0', 'bin'),
      join(home, '.volta', 'bin'),
      join(home, '.local', 'bin'),
      join(home, '.bun', 'bin'),
      join(home, '.cargo', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/custom/bin'
    ])
  })

  it('places nvm before Homebrew so `env node` picks the user Node', () => {
    makeNvm(['v22.14.0'], { default: 'node' })
    const parts = buildFallbackPath({ home, nvmDir, existingPath: '', exists: (d) => d.startsWith(home) || d === '/opt/homebrew/bin' }).split(':')
    expect(parts.indexOf(join(nvmDir, 'versions', 'node', 'v22.14.0', 'bin'))).toBeLessThan(parts.indexOf('/opt/homebrew/bin'))
  })
})

describe('shell output parsing', () => {
  it('extracts marked values from noisy output', () => {
    const out = '\x1b[1mwelcome\x1b[0m\n__20X_PATH_START__/a:/b__20X_PATH_END__\n__20X_OPENAI_API_KEY_START____20X_OPENAI_API_KEY_END__\n__20X_CODEX_HOME_START__/x/.codex__20X_CODEX_HOME_END__\n'
    expect(parseShellEnvOutput(out)).toEqual({ PATH: '/a:/b', CODEX_HOME: '/x/.codex' })
    expect(buildShellEnvCommand()).toContain('"$CODEX_HOME"')
  })

  it('uses stdout even when the shell exits non-zero or times out, if markers are present', async () => {
    const calls: string[][] = []
    const run = async (_shell: string, args: string[]): Promise<ShellRunResult> => {
      calls.push(args)
      return { stdout: 'noise\n__20X_PATH_START__/nvm/bin:/usr/bin__20X_PATH_END__\n', stderr: 'compinit: insecure dirs', code: 1, timedOut: false }
    }
    const result = await readShellEnv({ shell: '/bin/zsh', run })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.values.PATH).toBe('/nvm/bin:/usr/bin')
      expect(result.flags).toBe('-ilc')
      expect(result.warning).toContain('exit code 1')
    }
    expect(calls).toHaveLength(1)
  })

  it('retries with -lc when -ilc yields no markers, then reports both failures', async () => {
    const flags: string[] = []
    const okRun = async (_s: string, args: string[]): Promise<ShellRunResult> => {
      flags.push(args[0])
      return args[0] === '-ilc'
        ? { stdout: '', stderr: '', code: null, timedOut: true }
        : { stdout: '__20X_PATH_START__/usr/bin__20X_PATH_END__', stderr: '', code: 0, timedOut: false }
    }
    const ok = await readShellEnv({ shell: '/bin/zsh', run: okRun, timeoutMs: 10 })
    expect(flags).toEqual(['-ilc', '-lc'])
    expect(ok.ok && ok.flags).toBe('-lc')

    const failRun = async (): Promise<ShellRunResult> => ({ stdout: '', stderr: '', code: null, timedOut: true })
    const fail = await readShellEnv({ shell: '/bin/zsh', run: failRun, timeoutMs: 10 })
    expect(fail.ok).toBe(false)
    if (!fail.ok) {
      expect(fail.reason).toContain('-ilc: timed out after 10ms')
      expect(fail.reason).toContain('-lc: timed out after 10ms')
    }
  })
})
