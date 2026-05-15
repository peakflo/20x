import { describe, expect, it } from 'vitest'
import packageJson from '../package.json'
import { getCiMacBuildConfig } from './electron-builder-ci-mac-config-helper'

describe('electron-builder-ci-mac-config', () => {
  it('removes afterSign from the base electron-builder config', () => {
    const config = getCiMacBuildConfig(packageJson.build)

    expect(config.afterSign).toBeUndefined()
    expect(config.afterPack).toBe('./scripts/after-pack.js')
    expect(config.mac).toEqual({
      ...packageJson.build.mac,
      notarize: false
    })
    expect(config.win).toEqual(packageJson.build.win)
    expect(config.linux).toEqual(packageJson.build.linux)
  })
})
