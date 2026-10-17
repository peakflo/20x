import { describe, expect, it } from 'vitest'
import { desktopBrandName } from './brand'

describe('visible desktop name', () => {
  it('uses the selected build flag without changing the old default', () => {
    expect(desktopBrandName('Workflo', false)).toBe('Workflo')
    expect(desktopBrandName('Peakflo Workflo', true)).toBe('Spaces')
  })
})
