import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fork: vi.fn(), showMessageBox: vi.fn(async () => ({ response: 0 })) }))
vi.mock('electron', () => ({ utilityProcess: { fork: mocks.fork }, dialog: { showMessageBox: mocks.showMessageBox } }))
import { startMacosSwapWatchdog, swapWatchdogScriptPath } from './macos-swap-watchdog'

describe('watchdog entry path', () => {
  it('uses the unpacked worker in an installed application', () => {
    expect(swapWatchdogScriptPath('/Applications/20x.app/Contents/Resources/app.asar/out/main'))
      .toBe('/Applications/20x.app/Contents/Resources/app.asar.unpacked/out/main/macos-swap-watchdog-worker.js')
  })

  it('uses the built file during development', () => {
    expect(swapWatchdogScriptPath('/repo/out/main')).toBe('/repo/out/main/macos-swap-watchdog-worker.js')
  })
})

describe.skipIf(process.platform !== 'darwin')('watchdog lifecycle', () => {
  let child: EventEmitter & { postMessage: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> }
  beforeEach(() => {
    vi.clearAllMocks()
    child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() })
    mocks.fork.mockReturnValue(child)
  })

  it('answers heartbeats and stops exactly once on shutdown', () => {
    const stop = startMacosSwapWatchdog()
    child.emit('message', { type: 'ping' })
    expect(child.postMessage).toHaveBeenCalledWith({ type: 'pong' })
    stop()
    stop()
    child.emit('message', { type: 'ping' })
    expect(child.postMessage).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('warns without starting multiple dialogs while the first is open', async () => {
    startMacosSwapWatchdog()
    child.emit('message', { type: 'low-disk', freeBytes: 100 })
    child.emit('message', { type: 'low-disk', freeBytes: 100 })
    expect(mocks.showMessageBox).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(mocks.showMessageBox).toHaveResolved())
  })

  it('does not crash main if the helper fails to launch', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.fork.mockImplementationOnce(() => { throw new Error('fork failed') })
    expect(() => startMacosSwapWatchdog()()).not.toThrow()
    warning.mockRestore()
  })
})
