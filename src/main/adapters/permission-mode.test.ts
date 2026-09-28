import { describe, expect, it } from 'vitest'

import { claudeCodePermissionMode } from './permission-mode'

/**
 * DEFECT G1 IN 20x: `claude-code-adapter.ts` hardcoded
 * `permissionMode: 'bypassPermissions'` and `allowDangerouslySkipPermissions: true`,
 * so every Claude Code session ran fully unrestricted no matter what the user
 * had chosen — while `agent-manager.ts` had been passing the real per-agent
 * setting into the config all along, at three separate call sites.
 *
 * These tests pin the resolution that replaced the hardcode.
 */
describe('claudeCodePermissionMode', () => {
  it('resolves an explicit allow to a real bypass', () => {
    expect(claudeCodePermissionMode({ permissionMode: 'allow' })).toBe('bypassPermissions')
    // sandboxMode must not be able to talk it out of the user's explicit choice.
    expect(claudeCodePermissionMode({ permissionMode: 'allow', sandboxMode: 'read-only' })).toBe(
      'bypassPermissions'
    )
  })

  it('resolves ask + read-only to plan, and ask + workspace-write to default', () => {
    expect(claudeCodePermissionMode({ permissionMode: 'ask', sandboxMode: 'read-only' })).toBe('plan')
    expect(claudeCodePermissionMode({ permissionMode: 'ask', sandboxMode: 'workspace-write' })).toBe(
      'default'
    )
  })

  /**
   * THE ASSERTION THAT MATTERS MOST.
   *
   * If an absent mode resolved back to `bypassPermissions`, then every caller
   * that forgot to set the field would silently restore the defect — and the
   * restoration would be invisible, because the observable behaviour would be
   * identical to the code we just deleted.
   */
  it('NEVER resolves an absent mode to a bypass', () => {
    expect(claudeCodePermissionMode({})).toBe('default')
    expect(claudeCodePermissionMode({ permissionMode: 'ask' })).toBe('default')
    expect(claudeCodePermissionMode({ sandboxMode: 'workspace-write' })).toBe('default')
    expect(claudeCodePermissionMode({ sandboxMode: 'danger-full-access' })).toBe('default')
  })

  it('is total — every input yields a defined mode, and only allow yields a bypass', () => {
    const inputs = [
      {},
      { permissionMode: 'ask' as const },
      { permissionMode: 'allow' as const },
      { sandboxMode: 'read-only' as const },
      { sandboxMode: 'workspace-write' as const },
      { sandboxMode: 'danger-full-access' as const },
      { permissionMode: 'ask' as const, sandboxMode: 'danger-full-access' as const }
    ]
    for (const input of inputs) {
      const resolved = claudeCodePermissionMode(input)
      expect(resolved).toBeTruthy()
      // The one-way door: a bypass is reachable ONLY from an explicit allow.
      if (resolved === 'bypassPermissions') {
        expect(input).toHaveProperty('permissionMode', 'allow')
      }
    }
  })
})
