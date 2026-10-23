import { describe, it, expect } from 'vitest'
import { createCwdTracker, shellIntegrationArgs } from './terminal-shell-integration'

const osc = (path: string, end = '\x07') => `\x1b]9;9;${path}${end}`

describe('createCwdTracker', () => {
  it('reports null until the shell has printed a prompt', () => {
    expect(createCwdTracker().current()).toBeNull()
  })

  it('keeps the last directory reported', () => {
    const tracker = createCwdTracker()
    tracker.push(`PS> ${osc('C:\\a')}ls\r\n${osc('C:\\Users\\A B\\proj')}PS> `)
    expect(tracker.current()).toBe('C:\\Users\\A B\\proj')
  })

  it('accepts a string terminator and a quoted path', () => {
    const tracker = createCwdTracker()
    tracker.push(osc('"C:\\x y"', '\x1b\\'))
    expect(tracker.current()).toBe('C:\\x y')
  })

  it('joins a sequence split across chunks', () => {
    const tracker = createCwdTracker()
    tracker.push('out\x1b]9;9;C:\\spl')
    expect(tracker.current()).toBeNull()
    tracker.push('it\x07more')
    expect(tracker.current()).toBe('C:\\split')
  })

  it('joins an introducer split across chunks', () => {
    const tracker = createCwdTracker()
    tracker.push('x\x1b]9')
    tracker.push(';9;D:\\y\x07')
    expect(tracker.current()).toBe('D:\\y')
  })

  it('ignores unrelated escape sequences', () => {
    const tracker = createCwdTracker()
    tracker.push('\x1b[31mred\x1b[0m\x1b]0;title\x07')
    expect(tracker.current()).toBeNull()
  })
})

describe('shellIntegrationArgs', () => {
  it('hooks PowerShell and cmd on Windows only', () => {
    expect(shellIntegrationArgs('powershell.exe', 'win32')).toContain('-NoExit')
    expect(shellIntegrationArgs('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32')).toContain('-Command')
    expect(shellIntegrationArgs('cmd.exe', 'win32')[0]).toBe('/K')
    expect(shellIntegrationArgs('bash.exe', 'win32')).toEqual([])
    expect(shellIntegrationArgs('powershell.exe', 'linux')).toEqual([])
  })
})
