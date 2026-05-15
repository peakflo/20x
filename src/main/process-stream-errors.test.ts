import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleProcessStreamError } from './process-stream-errors'

describe('handleProcessStreamError', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each(['EPIPE', 'EIO'])('ignores %s without logging or throwing', (code) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => {
      handleProcessStreamError('stderr', Object.assign(new Error(code), { code }))
    }).not.toThrow()

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('logs unexpected stream errors without throwing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const err = Object.assign(new Error('unexpected stream failure'), { code: 'EINVAL' })

    expect(() => {
      handleProcessStreamError('stdout', err)
    }).not.toThrow()

    expect(warnSpy).toHaveBeenCalledWith('[Main] Ignoring stdout error:', err)
  })

  it('does not throw when fallback logging fails', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('console unavailable')
    })

    expect(() => {
      handleProcessStreamError(
        'stderr',
        Object.assign(new Error('unexpected stream failure'), { code: 'EINVAL' })
      )
    }).not.toThrow()
  })
})
