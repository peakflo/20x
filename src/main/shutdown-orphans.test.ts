import { describe, expect, it } from 'vitest'
import { getOrphanMcpKillCommand, killOrphanedMcpProcesses } from './shutdown-orphans'

describe('getOrphanMcpKillCommand', () => {
  it('uses PowerShell command-line matching on Windows', () => {
    const cmd = getOrphanMcpKillCommand('win32')

    expect(cmd).toContain('powershell.exe')
    expect(cmd).toContain('task-management-mcp')
    expect(cmd).toContain('Win32_Process')
    expect(cmd).not.toContain('WINDOWTITLE')
  })

  it('uses pkill on Unix platforms', () => {
    expect(getOrphanMcpKillCommand('darwin')).toBe('pkill -f "task-management-mcp\\.js"')
    expect(getOrphanMcpKillCommand('linux')).toBe('pkill -f "task-management-mcp\\.js"')
  })
})

describe('killOrphanedMcpProcesses', () => {
  it('does not throw when no matching processes exist', () => {
    expect(() => killOrphanedMcpProcesses(process.platform)).not.toThrow()
  })
})
