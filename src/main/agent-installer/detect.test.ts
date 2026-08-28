import { describe, expect, it } from 'vitest'

import { isVersionAtLeast, MINIMUM_PI_VERSION } from './detect.js'

describe('Pi version support', () => {
  it('accepts the minimum and newer versions', () => {
    expect(isVersionAtLeast(MINIMUM_PI_VERSION, MINIMUM_PI_VERSION)).toBe(true)
    expect(isVersionAtLeast('0.84.3', MINIMUM_PI_VERSION)).toBe(true)
    expect(isVersionAtLeast('1.0.0', MINIMUM_PI_VERSION)).toBe(true)
  })

  it('rejects versions older than the supported RPC runtime', () => {
    expect(isVersionAtLeast('0.80.4', MINIMUM_PI_VERSION)).toBe(false)
    expect(isVersionAtLeast('0.79.9', MINIMUM_PI_VERSION)).toBe(false)
  })
})
