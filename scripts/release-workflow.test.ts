import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

describe('release workflow windows native build prerequisites', () => {
  it('configures Python 3.11 before Windows packaging steps', () => {
    const workflowPath = join(__dirname, '..', '.github', 'workflows', 'release.yml')
    const workflow = readFileSync(workflowPath, 'utf8')

    const windowsJobStart = workflow.indexOf('  build-windows:')
    const linuxJobStart = workflow.indexOf('  build-linux:')
    expect(windowsJobStart).toBeGreaterThan(-1)
    expect(linuxJobStart).toBeGreaterThan(windowsJobStart)

    const windowsJob = workflow.slice(windowsJobStart, linuxJobStart)

    expect(windowsJob).toContain('- uses: actions/setup-python@v5')
    expect(windowsJob).toContain("python-version: '3.11'")

    const setupPythonIndex = windowsJob.indexOf('- uses: actions/setup-python@v5')
    const installIndex = windowsJob.indexOf('- run: pnpm install --frozen-lockfile')
    expect(setupPythonIndex).toBeGreaterThan(-1)
    expect(installIndex).toBeGreaterThan(-1)
    expect(setupPythonIndex).toBeLessThan(installIndex)
  })
})
