import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tempUserData = mkdtempSync(join(tmpdir(), '20x-crash-logger-'))
const showErrorBox = vi.fn()

vi.mock('electron', () => ({
  app: {
    getPath: () => tempUserData,
    getVersion: () => '0.0.0-test',
    on: vi.fn()
  },
  dialog: { showErrorBox }
}))

/**
 * The crash dialog is the user-visible symptom of the EPIPE bug: the pipe
 * failure is harmless, the application keeps running, but the user is told to
 * restart it. Benign stream errors must be logged and nothing more.
 */
describe('initCrashLogger uncaughtException handling', () => {
  let handlers: Array<(error: Error) => void>
  let originalOn: typeof process.on

  beforeEach(async () => {
    handlers = []
    showErrorBox.mockClear()
    originalOn = process.on.bind(process)
    vi.spyOn(process, 'on').mockImplementation(((event: string, listener: never) => {
      if (event === 'uncaughtException') handlers.push(listener as (error: Error) => void)
      return process
    }) as typeof process.on)

    const { initCrashLogger } = await import('./crash-logger')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    initCrashLogger()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.on = originalOn
  })

  it('does not show a crash dialog for a pipe teardown', () => {
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })

    for (const handler of handlers) handler(epipe)

    expect(showErrorBox).not.toHaveBeenCalled()
  })

  it('still records the pipe teardown in the crash log', () => {
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })

    for (const handler of handlers) handler(epipe)

    const log = readFileSync(join(tempUserData, 'logs', 'crash.log'), 'utf-8')
    expect(log).toContain('non-fatal stream error')
    expect(log).toContain('write EPIPE')
  })

  it('still shows a crash dialog for a genuine fault', () => {
    for (const handler of handlers) handler(new Error('genuine failure'))

    expect(showErrorBox).toHaveBeenCalledTimes(1)
    expect(showErrorBox.mock.calls[0][1]).toContain('genuine failure')
  })
})
