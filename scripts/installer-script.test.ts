import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

describe('installer script', () => {
  it('skips app data removal prompt during NSIS upgrades', () => {
    const script = readFileSync(join(__dirname, '..', 'resources', 'installer.nsh'), 'utf8')

    const upgradeGuardIndex = script.indexOf('${if} ${isUpdated}')
    const promptIndex = script.indexOf('Do you want to remove your 20x data')

    expect(upgradeGuardIndex).toBeGreaterThan(-1)
    expect(promptIndex).toBeGreaterThan(-1)
    expect(upgradeGuardIndex).toBeLessThan(promptIndex)
  })
})
