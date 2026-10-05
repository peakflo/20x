import { describe, it, expect } from 'vitest'
import {
  defaultHarnessInstanceId,
  harnessDropdownOptions,
  harnessInstanceDisplayName,
  harnessTypeOf,
  isDefaultHarnessInstanceId,
  signInCommand
} from './harness-instances'

describe('signInCommand', () => {
  it('quotes the home for POSIX shells', () => {
    expect(signInCommand('codex', '/Users/me/.codex-work', 'posix')).toBe('CODEX_HOME="/Users/me/.codex-work" codex login')
    expect(signInCommand('claude-code', '/Users/me/.claude-personal', 'posix')).toBe('CLAUDE_CONFIG_DIR="/Users/me/.claude-personal" claude /login')
  })

  it('escapes characters that a POSIX shell would expand inside double quotes', () => {
    expect(signInCommand('codex', '/tmp/a "b" $HOME `x` \\y', 'posix')).toBe('CODEX_HOME="/tmp/a \\"b\\" \\$HOME \\`x\\` \\\\y" codex login')
  })

  it('sets the variable for PowerShell and escapes its own special characters', () => {
    expect(signInCommand('codex', 'C:\\Users\\me\\codex work', 'powershell')).toBe('$env:CODEX_HOME = "C:\\Users\\me\\codex work"; codex login')
    expect(signInCommand('claude-code', 'C:\\a "b" $c', 'powershell')).toBe('$env:CLAUDE_CONFIG_DIR = "C:\\a `"b`" `$c"; claude /login')
  })
})

describe('harness instance identity', () => {
  it('maps a coding agent to its harness type, and nothing else to one', () => {
    expect(harnessTypeOf('codex')).toBe('codex')
    expect(harnessTypeOf('claude-code')).toBe('claude-code')
    expect(harnessTypeOf('opencode')).toBeNull()
    expect(harnessTypeOf(undefined)).toBeNull()
  })

  it('gives each provider a default instance id that is recognised as a default', () => {
    expect(defaultHarnessInstanceId('codex')).toBe('default:codex')
    expect(isDefaultHarnessInstanceId('default:claude-code')).toBe(true)
    expect(isDefaultHarnessInstanceId('hi_abc')).toBe(false)
  })

  it('names an account by its harness and label', () => {
    expect(harnessInstanceDisplayName('codex', 'Work')).toBe('Codex · Work')
  })
})

describe('harnessDropdownOptions', () => {
  const harnesses = [
    { value: 'opencode', label: 'OpenCode' },
    { value: 'claude-code', label: 'Claude Code' },
    { value: 'codex', label: 'Codex' },
    { value: 'pi', label: 'Pi' }
  ]

  it('lists each harness default, with its accounts after it', () => {
    const options = harnessDropdownOptions(
      [
        { id: 'hi_w', harness_type: 'codex', label: 'Work' },
        { id: 'hi_p', harness_type: 'codex', label: 'Personal' },
        { id: 'hi_c', harness_type: 'claude-code', label: 'Team' }
      ],
      harnesses
    )
    expect(options).toEqual([
      { value: 'opencode', label: 'OpenCode' },
      { value: 'claude-code', label: 'Claude Code' },
      { value: 'instance:hi_c', label: 'Claude Code · Team' },
      { value: 'codex', label: 'Codex' },
      { value: 'instance:hi_w', label: 'Codex · Work' },
      { value: 'instance:hi_p', label: 'Codex · Personal' },
      { value: 'pi', label: 'Pi' }
    ])
  })

  it('lists only the defaults when no account is stored', () => {
    expect(harnessDropdownOptions([], harnesses).map((o) => o.value)).toEqual(['opencode', 'claude-code', 'codex', 'pi'])
  })
})
