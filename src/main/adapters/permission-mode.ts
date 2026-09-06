/**
 * THE PERMISSION-MODE MAPPING — defect G1's other half, in 20x.
 *
 * READ THIS BEFORE COMPARING WITH THE WORKFLOW-BUILDER COPY. The two files are
 * deliberately close but the STORY IS NOT THE SAME in the two products, and an
 * earlier draft of this file carried workflow-builder's version of it, which
 * was simply untrue here.
 *
 * WHAT WAS ACTUALLY WRONG IN 20x. `SessionConfig.permissionMode` was populated
 * correctly all along — `agent-manager.ts` sets it from the per-agent
 * `permission_mode` at three separate call sites (:844, :1568, :2829), and
 * OpenCode, Codex, ACP and Pi all honour it. Only ONE adapter ignored it:
 * `claude-code-adapter.ts` hardcoded `permissionMode: 'bypassPermissions'` with
 * `allowDangerouslySkipPermissions: true`. So the value travelled the whole way
 * and was dropped at the last step, by one backend.
 *
 * (In workflow-builder the failure is one step earlier — the runner never put
 * the value into the config at all. Same defect id, different missing wire.)
 *
 * WHY ONLY THE INVERSE FUNCTION LIVES HERE. 20x stores the two-valued form
 * DIRECTLY: `AgentConfigRecord.permission_mode` is `'ask' | 'allow'`
 * (database.ts:40) and the agent form offers exactly those. There is no
 * four-valued vocabulary in this product, so a four-to-two mapping would have
 * no caller — dead code that reads as though something used it. The four-valued
 * side belongs to the control plane, and it lives in
 * `workflow-builder/packages/agent-harness/src/runtime/permission-mode.ts`,
 * where the lease actually carries those values.
 *
 * THE RULE BOTH COPIES OBEY: **a mode may resolve to something STRICTER than
 * the user asked for, never to something looser.** `'bypassPermissions'` is
 * reachable from exactly one input, an explicit `'allow'`, and from nothing
 * else — including from an ABSENT mode, which is the pre-G1 state and must
 * never silently become a bypass again.
 *
 * ---------------------------------------------------------------------------
 * THE TABLE THIS FILE IMPLEMENTS
 * ---------------------------------------------------------------------------
 *
 *  permissionMode | sandboxMode        | Claude Code mode
 *  ---------------|--------------------|------------------
 *  'allow'        | (any)              | 'bypassPermissions'
 *  'ask'          | 'read-only'        | 'plan'
 *  'ask'          | 'workspace-write'  | 'default'
 *  'ask'          | (absent)           | 'default'
 *  (absent)       | (absent)           | 'default'      <-- NOT bypass
 *
 * Claude Code is the one backend whose SDK takes all four values natively, so
 * nothing is collapsed here. On OpenCode there is a permission prompt or there
 * is none, which is why 20x's own stored vocabulary is two-valued in the first
 * place.
 */

/** Claude Code's own four-valued vocabulary — the RESULT of the resolution. */
export type LeasePermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions'

/** What 20x stores and what the shared adapter contract accepts. */
export type AdapterPermissionMode = 'ask' | 'allow'

export type AdapterSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * Resolve the adapter's own two-valued permission setting — plus `sandboxMode`,
 * which carries the part `'ask' | 'allow'` cannot — into the four-valued
 * vocabulary Claude Code's SDK actually accepts.
 *
 * TOTAL BY DESIGN. Every input, including nonsense and absence, yields a
 * defined mode, and only an explicit `'allow'` yields `'bypassPermissions'`.
 * Absent `permissionMode` means the caller never set one: that is exactly the
 * pre-G1 state, so it maps to `'default'` — Claude Code's own asking mode — and
 * NOT back to the bypass that was the defect. If omission restored the old
 * behaviour, every caller that forgot the field would silently reintroduce G1
 * and no test would notice.
 */
export function claudeCodePermissionMode(config: {
  permissionMode?: AdapterPermissionMode
  sandboxMode?: AdapterSandboxMode
}): LeasePermissionMode {
  if (config.permissionMode === 'allow') {
    return 'bypassPermissions'
  }
  if (config.sandboxMode === 'read-only') {
    return 'plan'
  }
  if (config.sandboxMode === 'workspace-write') {
    // `acceptEdits` and `default` share a sandbox mode, so this direction
    // cannot tell them apart on its own. `default` is the stricter of the two
    // and therefore the right answer when in doubt.
    return 'default'
  }
  return 'default'
}
