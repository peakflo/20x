import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

// vi.mock is hoisted to the top of the file, so the factory can only reference
// variables created with vi.hoisted() (which is hoisted alongside it).
const mocks = vi.hoisted(() => ({ quick: vi.fn() }))

vi.mock('cloudflared', () => ({
  Tunnel: { quick: mocks.quick }
}))

// Import after the mock is registered.
import { startTunnel, stopTunnel, getTunnelUrl, isTunnelActive } from './tunnel-manager'

// Fake Tunnel that behaves like cloudflared's Tunnel EventEmitter.
class FakeTunnel extends EventEmitter {
  stop = vi.fn(() => true)
}

let lastTunnel: FakeTunnel | null = null

const URL = 'https://random-words.trycloudflare.com'

describe('tunnel-manager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    stopTunnel() // reset module state between tests
    lastTunnel = null
    mocks.quick.mockReset()
    mocks.quick.mockImplementation(() => {
      lastTunnel = new FakeTunnel()
      return lastTunnel
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    stopTunnel()
  })

  it('does NOT resolve on the `url` event alone — waits for `connected`', async () => {
    const p = startTunnel(20620)
    const t = lastTunnel!

    // URL is printed by cloudflared before the edge connection is up.
    t.emit('url', URL)
    await Promise.resolve()

    // Must not be considered ready yet: this is the root-cause bug we fixed.
    expect(getTunnelUrl()).toBeNull()
    expect(isTunnelActive()).toBe(false)

    // Now the connection registers.
    t.emit('connected', { id: 'c1', ip: '1.2.3.4', location: 'SIN' })

    await expect(p).resolves.toBe(URL)
    expect(getTunnelUrl()).toBe(URL)
    expect(isTunnelActive()).toBe(true)
  })

  it('rejects if a URL is produced but the tunnel never connects (timeout)', async () => {
    const p = startTunnel(20620)
    const t = lastTunnel!
    t.emit('url', URL)

    vi.advanceTimersByTime(120_000)

    await expect(p).rejects.toThrow(/never connected/i)
    expect(t.stop).toHaveBeenCalled()
    expect(getTunnelUrl()).toBeNull()
    expect(isTunnelActive()).toBe(false)
  })

  it('rejects on the `error` event', async () => {
    const p = startTunnel(20620)
    const t = lastTunnel!
    t.emit('error', new Error('spawn cloudflared ENOENT'))

    await expect(p).rejects.toThrow(/ENOENT/)
    expect(isTunnelActive()).toBe(false)
  })

  it('clears cached state when cloudflared exits so a dead URL is not reused', async () => {
    const p = startTunnel(20620)
    const t = lastTunnel!
    t.emit('url', URL)
    t.emit('connected', { id: 'c1', ip: '1.2.3.4', location: 'SIN' })
    await p

    expect(isTunnelActive()).toBe(true)

    // cloudflared process dies.
    t.emit('exit', 1, null)

    expect(getTunnelUrl()).toBeNull()
    expect(isTunnelActive()).toBe(false)

    // A fresh start spins up a new tunnel instead of returning the dead URL.
    const p2 = startTunnel(20620)
    expect(mocks.quick).toHaveBeenCalledTimes(2)
    lastTunnel!.emit('url', URL)
    lastTunnel!.emit('connected', { id: 'c2', ip: '1.2.3.4', location: 'SIN' })
    await expect(p2).resolves.toBe(URL)
  })
})
