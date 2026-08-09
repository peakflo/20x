import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { mkdirSync, writeFileSync } from 'fs'
import { mkdtemp, mkdir, writeFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('child_process', () => ({ spawn: spawnMock }))

const {
  VOICE_RUNTIME_PACKAGE,
  detectVoiceRuntime,
  installVoiceRuntime,
  isNpmAvailable,
  removeVoiceRuntime,
  runtimeModulePath,
} = await import('./voice-runtime-installer')

/**
 * A stand-in for a spawned process. It must be created inside a mock
 * *implementation*, not passed to `mockReturnValueOnce`, so the events fire
 * after the caller has attached its listeners.
 */
function fakeProcess(options: { exitCode?: number; stdout?: string; failToStart?: boolean }) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: () => void
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  setTimeout(() => {
    if (options.failToStart) {
      child.emit('error', new Error('spawn npm ENOENT'))
      return
    }
    if (options.stdout) child.stdout.emit('data', Buffer.from(options.stdout))
    child.emit('exit', options.exitCode ?? 0)
  }, 0)
  return child
}

let root: string

beforeEach(async () => {
  spawnMock.mockReset()
  root = await mkdtemp(join(tmpdir(), 'voice-runtime-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeInstalledRuntime(version: string): Promise<void> {
  const modulePath = runtimeModulePath(root)
  await mkdir(modulePath, { recursive: true })
  await writeFile(
    join(modulePath, 'package.json'),
    JSON.stringify({ name: VOICE_RUNTIME_PACKAGE, version }),
    'utf8'
  )
}

describe('detectVoiceRuntime', () => {
  it('reports a missing runtime instead of throwing', async () => {
    expect(await detectVoiceRuntime(root)).toMatchObject({
      installed: false,
      version: null,
      modulePath: null,
    })
  })

  it('reports the installed version and the path the worker loads', async () => {
    await writeInstalledRuntime('1.12.0')
    const status = await detectVoiceRuntime(root)
    expect(status.installed).toBe(true)
    expect(status.version).toBe('1.12.0')
    expect(status.modulePath).toBe(runtimeModulePath(root))
  })

  it('treats a damaged manifest as not installed', async () => {
    const modulePath = runtimeModulePath(root)
    await mkdir(modulePath, { recursive: true })
    await writeFile(join(modulePath, 'package.json'), 'not json at all', 'utf8')
    expect((await detectVoiceRuntime(root)).installed).toBe(false)
  })
})

describe('isNpmAvailable', () => {
  it('is false when npm cannot start', async () => {
    spawnMock.mockImplementation(() => fakeProcess({ failToStart: true }))
    expect(await isNpmAvailable()).toBe(false)
  })

  it('is true when npm answers', async () => {
    spawnMock.mockImplementation(() => fakeProcess({ exitCode: 0 }))
    expect(await isNpmAvailable()).toBe(true)
  })
})

describe('installVoiceRuntime', () => {
  it('explains that npm is needed and downloads nothing', async () => {
    spawnMock.mockImplementation(() => fakeProcess({ failToStart: true }))
    const progress = vi.fn()

    await expect(installVoiceRuntime(root, progress)).rejects.toThrow(/npm was not found/i)
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: 'error' }))
    // Only the version probe ran.
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('reports a failed install instead of claiming success', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProcess({ exitCode: 0 })) // npm --version
      .mockImplementationOnce(() => fakeProcess({ exitCode: 1, stdout: 'npm error\n' })) // npm install
    const progress = vi.fn()

    await expect(installVoiceRuntime(root, progress)).rejects.toThrow(/exited with code 1/i)
    expect((await detectVoiceRuntime(root)).installed).toBe(false)
  })

  it('installs into the application data directory and reports the version', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProcess({ exitCode: 0 }))
      .mockImplementationOnce(() => {
        // Stand in for what npm writes. It must land before the process exits,
        // so this is written synchronously.
        const modulePath = runtimeModulePath(root)
        mkdirSync(modulePath, { recursive: true })
        writeFileSync(
          join(modulePath, 'package.json'),
          JSON.stringify({ name: VOICE_RUNTIME_PACKAGE, version: '1.12.0' })
        )
        return fakeProcess({ exitCode: 0, stdout: 'added 1 package\n' })
      })
    const progress = vi.fn()

    const status = await installVoiceRuntime(root, progress)
    expect(status).toMatchObject({ installed: true, version: '1.12.0' })
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: 'complete', percent: 100 }))

    // npm runs inside the runtime directory, never inside the app bundle.
    const [, , options] = spawnMock.mock.calls[1]
    expect(options).toMatchObject({ cwd: root })
    // A private manifest keeps npm from walking up into the app directory.
    await expect(stat(join(root, 'package.json'))).resolves.toBeTruthy()
  })
})

describe('removeVoiceRuntime', () => {
  it('gives the disk space back', async () => {
    await writeInstalledRuntime('1.12.0')
    await removeVoiceRuntime(root)
    expect((await detectVoiceRuntime(root)).installed).toBe(false)
    await expect(stat(root)).rejects.toThrow()
  })
})
