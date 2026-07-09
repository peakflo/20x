import { describe, expect, it } from 'vitest'
import { buildWindowsSecretShellScript } from './secret-broker'

describe('buildWindowsSecretShellScript', () => {
  it('fetches secrets from the local broker via Invoke-WebRequest', () => {
    const script = buildWindowsSecretShellScript('C:\\Users\\test\\AppData\\Roaming\\20x\\secret-shell-debug.log')

    expect(script).toContain('Invoke-WebRequest')
    expect(script).toContain('/secrets/export?token=')
    expect(script).toContain('$env:_20X_SB_PORT')
    expect(script).toContain('$env:_20X_SB_TOKEN')
  })

  it('parses bash-style export lines into environment variables', () => {
    const script = buildWindowsSecretShellScript('C:\\logs\\debug.log')

    expect(script).toContain('^export\\s+([^=]+)=(.*)$')
    expect(script).toContain('[Environment]::SetEnvironmentVariable')
  })

  it('escapes backslashes in the debug log path', () => {
    const script = buildWindowsSecretShellScript('C:\\Users\\test\\debug.log')

    expect(script).toContain('C:\\\\Users\\\\test\\\\debug.log')
  })

  it('clears broker env vars after fetching secrets', () => {
    const script = buildWindowsSecretShellScript('C:\\logs\\debug.log')

    expect(script).toContain('Remove-Item Env:\\_20X_SB_PORT')
    expect(script).toContain('Remove-Item Env:\\_20X_SB_TOKEN')
    expect(script).toContain('Remove-Item Env:\\_20X_REAL_SHELL')
  })
})
