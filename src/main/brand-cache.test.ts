import { describe, expect, it, vi } from 'vitest'
import { createBrandFlagCache } from '../preload/brand-cache'

describe('renderer brand flag cache', () => {
  it('reads the main process once across repeated render calls', () => {
    const readCurrent = vi.fn(() => true)
    const cache = createBrandFlagCache(readCurrent)
    for (let call = 0; call < 6; call++) expect(cache.get()).toBe(true)
    expect(readCurrent).toHaveBeenCalledTimes(1)
  })

  it('uses company changes without another synchronous read', () => {
    const readCurrent = vi.fn(() => false)
    const cache = createBrandFlagCache(readCurrent)
    expect(cache.get()).toBe(false)
    cache.update(true)
    expect(cache.get()).toBe(true)
    cache.update(false)
    expect(cache.get()).toBe(false)
    expect(readCurrent).toHaveBeenCalledTimes(1)
  })

  it('uses an early change event before the first read', () => {
    const readCurrent = vi.fn(() => false)
    const cache = createBrandFlagCache(readCurrent)
    cache.update(true)
    expect(cache.get()).toBe(true)
    expect(readCurrent).not.toHaveBeenCalled()
  })
})
