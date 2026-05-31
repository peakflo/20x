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

  it('bootstraps Python during Windows install when it is missing', () => {
    const script = readFileSync(join(__dirname, '..', 'resources', 'installer.nsh'), 'utf8')

    expect(script).toContain('Function InstallPythonIfMissing')
    expect(script).toContain('where.exe" python.exe')
    expect(script).toContain('where.exe" py.exe')
    expect(script).toContain('https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-amd64.exe')
    expect(script).toContain('Invoke-WebRequest')
    expect(script).toContain('-ExecutionPolicy Bypass')
    expect(script).toContain('Section "-InstallPython"')
    expect(script).toContain('/quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1 Include_pip=1')
    expect(script).toContain('Call BroadcastEnvironmentChange')
  })
})
