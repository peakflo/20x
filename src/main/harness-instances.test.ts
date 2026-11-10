import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  directoryLinkType,
  instanceHomeError,
  instanceHomeFor,
  linkSharedHistory,
  normalizeHomePath,
  realHomeFor,
  type LinkFn,
  type LinkType
} from './harness-instances'
import { isWindows } from '../../test/helpers/can-symlink'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harness-instances-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

describe('home directories', () => {
  it.skipIf(isWindows)('honours an inherited CODEX_HOME and CLAUDE_CONFIG_DIR as the real default home', () => {
    expect(realHomeFor('codex', { CODEX_HOME: '/opt/codex' }, '/home/u')).toBe('/opt/codex')
    expect(realHomeFor('claude-code', { CLAUDE_CONFIG_DIR: '/opt/claude' }, '/home/u')).toBe('/opt/claude')
  })

  it('falls back to ~/.codex and ~/.claude when nothing is inherited', () => {
    expect(realHomeFor('codex', {}, '/home/u')).toBe(join('/home/u', '.codex'))
    expect(realHomeFor('claude-code', { CODEX_HOME: '' }, '/home/u')).toBe(join('/home/u', '.claude'))
  })

  it.skipIf(isWindows)('uses the stored path for a custom instance and the real default for the implicit one', () => {
    expect(instanceHomeFor('codex', undefined, { CODEX_HOME: '/opt/codex' }, '/home/u')).toBe('/opt/codex')
    expect(instanceHomeFor('codex', '/accounts/work', {}, '/home/u')).toBe('/accounts/work')
  })

  it('expands ~ and resolves relative paths, and treats blank input as unset', () => {
    expect(normalizeHomePath('~/accounts/work', '/home/u')).toBe(join('/home/u', 'accounts/work'))
    expect(normalizeHomePath('   ', '/home/u')).toBeUndefined()
    expect(normalizeHomePath(null, '/home/u')).toBeUndefined()
  })
})

describe('shared session history', () => {
  it.skipIf(isWindows)('links Codex sessions and config to the real default home and keeps its own login', () => {
    const real = join(root, 'codex-default')
    const instance = join(root, 'codex-work')
    mkdirSync(real)
    writeFileSync(join(real, 'config.toml'), 'model = "gpt"')

    const result = linkSharedHistory({ harness: 'codex', instanceHome: instance, realHome: real, platform: 'darwin' })

    expect(result.shareable).toBe(true)
    for (const name of ['sessions', 'archived_sessions', 'skills', 'prompts', 'sqlite']) {
      expect(isLink(join(instance, name))).toBe(true)
      expect(readlinkSync(join(instance, name))).toBe(join(real, name))
    }
    expect(readFileSync(join(instance, 'config.toml'), 'utf8')).toBe('model = "gpt"')
    // The login and the model cache are per instance, so they are never linked.
    expect(existsSync(join(instance, 'auth.json'))).toBe(false)
    expect(existsSync(join(instance, 'models_cache.json'))).toBe(false)
  })

  it.skipIf(isWindows)('links Claude session history but not the login or the live session registry', () => {
    const real = join(root, 'claude-default')
    const instance = join(root, 'claude-personal')
    mkdirSync(real)

    const result = linkSharedHistory({ harness: 'claude-code', instanceHome: instance, realHome: real, platform: 'linux' })

    expect(result.shareable).toBe(true)
    expect(readlinkSync(join(instance, 'projects'))).toBe(join(real, 'projects'))
    expect(readlinkSync(join(instance, 'todos'))).toBe(join(real, 'todos'))
    expect(existsSync(join(instance, 'sessions'))).toBe(false)
    expect(existsSync(join(instance, '.credentials.json'))).toBe(false)
    expect(existsSync(join(instance, 'settings.json'))).toBe(false)
  })

  it.skipIf(isWindows)('is idempotent', () => {
    const real = join(root, 'codex-default')
    const instance = join(root, 'codex-work')
    linkSharedHistory({ harness: 'codex', instanceHome: instance, realHome: real, platform: 'linux' })
    const again = linkSharedHistory({ harness: 'codex', instanceHome: instance, realHome: real, platform: 'linux' })
    expect(again.shareable).toBe(true)
    expect(again.links.filter((l) => l.status === 'already-linked').length).toBeGreaterThan(0)
  })

  it('never replaces a real directory that holds sessions, and marks the instance not shareable', () => {
    const real = join(root, 'codex-default')
    const instance = join(root, 'codex-work')
    mkdirSync(join(instance, 'sessions'), { recursive: true })
    writeFileSync(join(instance, 'sessions', 'rollout.jsonl'), '{}')

    const result = linkSharedHistory({ harness: 'codex', instanceHome: instance, realHome: real, platform: 'linux' })

    expect(result.shareable).toBe(false)
    expect(result.links).toContainEqual({ name: 'sessions', status: 'real-data' })
    expect(isLink(join(instance, 'sessions'))).toBe(false)
    expect(readFileSync(join(instance, 'sessions', 'rollout.jsonl'), 'utf8')).toBe('{}')
  })

  it.skipIf(isWindows)('marks the instance not shareable when a shared path links somewhere else', () => {
    const real = join(root, 'claude-default')
    const instance = join(root, 'claude-personal')
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(instance, { recursive: true })
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(instance, 'projects'), 'dir')

    const result = linkSharedHistory({ harness: 'claude-code', instanceHome: instance, realHome: real, platform: 'linux' })

    expect(result.shareable).toBe(false)
    expect(result.links).toContainEqual({ name: 'projects', status: 'other-link' })
    expect(readlinkSync(join(instance, 'projects'))).toBe(elsewhere)
  })

  it.skipIf(isWindows)('replaces an empty real directory, since no session can be lost', () => {
    const real = join(root, 'codex-default')
    const instance = join(root, 'codex-work')
    mkdirSync(join(instance, 'archived_sessions'), { recursive: true })

    const result = linkSharedHistory({ harness: 'codex', instanceHome: instance, realHome: real, platform: 'linux' })

    expect(result.shareable).toBe(true)
    expect(isLink(join(instance, 'archived_sessions'))).toBe(true)
  })

  it('uses a junction for shared directories on Windows (link type injected)', () => {
    const real = join(root, 'codex-default')
    const instance = join(root, 'codex-work')
    const types: Array<[string, LinkType]> = []
    const link: LinkFn = (target, path, type) => {
      types.push([path, type])
      mkdirSync(target, { recursive: true })
      mkdirSync(join(path, '..'), { recursive: true })
    }

    const result = linkSharedHistory({ harness: 'codex', instanceHome: instance, realHome: real, platform: 'win32', link })

    expect(result.shareable).toBe(true)
    const dirTypes = types.filter(([path]) => !path.endsWith('config.toml') && !path.endsWith('AGENTS.md'))
    expect(dirTypes.length).toBe(5)
    expect(dirTypes.every(([, type]) => type === 'junction')).toBe(true)
    expect(directoryLinkType('win32')).toBe('junction')
    expect(directoryLinkType('darwin')).toBe('dir')
    expect(directoryLinkType('linux')).toBe('dir')
  })

  it('marks the instance not shareable when a directory link cannot be created', () => {
    const real = join(root, 'claude-default')
    const instance = join(root, 'claude-personal')
    const link: LinkFn = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) }

    const result = linkSharedHistory({ harness: 'claude-code', instanceHome: instance, realHome: real, platform: 'win32', link })

    expect(result.shareable).toBe(false)
    expect(result.links.some((l) => l.status === 'failed')).toBe(true)
  })

  it('does nothing when the instance home is the real default home', () => {
    const real = join(root, 'codex-default')
    const result = linkSharedHistory({ harness: 'codex', instanceHome: real, realHome: real, platform: 'linux' })
    expect(result).toEqual({ shareable: true, links: [] })
  })

  it('shares an instance whose home was set to an inherited CODEX_HOME in the environment', () => {
    const real = join(root, 'inherited-codex')
    const env = { CODEX_HOME: real }
    const home = instanceHomeFor('codex', undefined, env, root)
    expect(linkSharedHistory({ harness: 'codex', instanceHome: home, realHome: realHomeFor('codex', env, root), platform: 'linux' }).shareable).toBe(true)
  })
})

describe('Windows file links without symlink privilege', () => {
  const eperm = (): never => {
    throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' })
  }

  it('hard-links shared settings files when file symlinks are refused', () => {
    const real = join(root, 'codex-default')
    const instance = join(root, 'codex-work')
    mkdirSync(real)
    writeFileSync(join(real, 'AGENTS.md'), 'rules')

    const result = linkSharedHistory({
      harness: 'codex',
      instanceHome: instance,
      realHome: real,
      platform: 'win32',
      link: (target, path, type) => (type === 'file' ? eperm() : symlinkSync(target, path, 'dir'))
    })

    expect(result.links.find((l) => l.name === 'AGENTS.md')?.status).toBe('linked')
    expect(readFileSync(join(instance, 'AGENTS.md'), 'utf-8')).toBe('rules')
    writeFileSync(join(real, 'AGENTS.md'), 'changed')
    expect(readFileSync(join(instance, 'AGENTS.md'), 'utf-8')).toBe('changed')
  })

  it('never hard-links a SQLite database, since its -wal file is named by path', () => {
    const real = join(root, 'codex-default')
    const instance = join(root, 'codex-work')
    mkdirSync(real)
    writeFileSync(join(real, 'state_5.sqlite'), 'db')

    const result = linkSharedHistory({
      harness: 'codex',
      instanceHome: instance,
      realHome: real,
      platform: 'win32',
      link: (target, path, type) => (type === 'file' ? eperm() : symlinkSync(target, path, 'dir'))
    })

    expect(result.links.find((l) => l.name === 'state_5.sqlite')?.status).toBe('failed')
    expect(existsSync(join(instance, 'state_5.sqlite'))).toBe(false)
  })

  it('does not fall back off Windows or for other errors', () => {
    const real = join(root, 'codex-default')
    mkdirSync(real)
    writeFileSync(join(real, 'AGENTS.md'), 'rules')
    const run = (platform: NodeJS.Platform, code: string, instance: string) =>
      linkSharedHistory({
        harness: 'codex',
        instanceHome: instance,
        realHome: real,
        platform,
        link: (target, path, type) => {
          if (type === 'file') throw Object.assign(new Error(code), { code })
          symlinkSync(target, path, 'dir')
        }
      }).links.find((l) => l.name === 'AGENTS.md')?.status

    expect(run('darwin', 'EPERM', join(root, 'a'))).toBe('failed')
    expect(run('win32', 'ENOSPC', join(root, 'b'))).toBe('failed')
  })
})

describe('Codex thread state', () => {
  it.skipIf(isWindows)('links the root-level SQLite databases where thread state lives, not their companions', () => {
    const real = join(root, 'codex-default')
    const instance = join(root, 'codex-work')
    mkdirSync(real)
    for (const name of ['state_5.sqlite', 'thread_history_1.sqlite', 'state_5.sqlite-wal', 'state_5.sqlite-shm']) {
      writeFileSync(join(real, name), '')
    }

    linkSharedHistory({ harness: 'codex', instanceHome: instance, realHome: real, platform: 'linux' })

    expect(readlinkSync(join(instance, 'state_5.sqlite'))).toBe(join(real, 'state_5.sqlite'))
    expect(readlinkSync(join(instance, 'thread_history_1.sqlite'))).toBe(join(real, 'thread_history_1.sqlite'))
    expect(existsSync(join(instance, 'state_5.sqlite-wal'))).toBe(false)
    expect(existsSync(join(instance, 'state_5.sqlite-shm'))).toBe(false)
  })

  it('copies config.toml once and never overwrites the instance copy', () => {
    const real = join(root, 'codex-default')
    const instance = join(root, 'codex-work')
    mkdirSync(real)
    writeFileSync(join(real, 'config.toml'), 'model = "a"')

    const first = linkSharedHistory({ harness: 'codex', instanceHome: instance, realHome: real, platform: 'linux' })
    expect(first.links).toContainEqual({ name: 'config.toml', status: 'copied' })
    expect(isLink(join(instance, 'config.toml'))).toBe(false)

    writeFileSync(join(real, 'config.toml'), 'model = "b"')
    writeFileSync(join(instance, 'config.toml'), 'model = "instance"')
    linkSharedHistory({ harness: 'codex', instanceHome: instance, realHome: real, platform: 'linux' })
    expect(readFileSync(join(instance, 'config.toml'), 'utf8')).toBe('model = "instance"')
  })
})

describe('instanceHomeError', () => {
  const env = {}
  const home = '/home/u'
  const check = (input: string, harness: 'codex' | 'claude-code' = 'codex', e: Record<string, string> = env) =>
    instanceHomeError(input, harness, e, home)

  it('accepts a separate absolute folder or one under ~', () => {
    expect(check('/accounts/codex-work')).toBeNull()
    expect(check('~/accounts/codex-work')).toBeNull()
  })

  it('rejects a blank or relative folder', () => {
    expect(check('  ')).toMatch(/Choose a folder/)
    expect(check('accounts/codex-work')).toMatch(/absolute folder path/)
  })

  it('rejects the home folder, the default home, and any ancestor of the default home', () => {
    expect(check('/home/u')).toMatch(/home folder/)
    expect(check('~')).toMatch(/home folder/)
    expect(check('/home/u/.codex')).toMatch(/default home/)
    expect(check('/home')).toMatch(/contains the default home/)
    expect(check('/')).toMatch(/contains the default home/)
  })

  it('treats an inherited CODEX_HOME as the default home', () => {
    expect(check('/opt/codex', 'codex', { CODEX_HOME: '/opt/codex' })).toMatch(/default home/)
    expect(check('/opt', 'codex', { CODEX_HOME: '/opt/codex' })).toMatch(/contains the default home/)
    expect(check('/opt/codex-work', 'codex', { CODEX_HOME: '/opt/codex' })).toBeNull()
  })

  it('applies the same rules to Claude Code', () => {
    expect(check('/home/u/.claude', 'claude-code')).toMatch(/default home/)
    expect(check('/home/u/.claude-work', 'claude-code')).toBeNull()
  })
})
