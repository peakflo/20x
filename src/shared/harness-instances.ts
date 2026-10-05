/**
 * Harness instances: one subscription login of a coding-agent harness.
 *
 * "Claude Code", "Claude Code · Personal", "Codex", "Codex · Work" are each a
 * separate instance. An agent picks one in its config, the same way it picks a
 * harness type. The built-in defaults ("Claude Code", "Codex") are implicit: they
 * use the harness's own home directory and are not stored rows.
 *
 * Renderer, main and mobile share this file. Keep Node and Electron imports out.
 */

export type HarnessType = 'claude-code' | 'codex'

export const HARNESS_TYPES: readonly HarnessType[] = ['claude-code', 'codex'] as const

/** A stored (non-default) harness instance, as persisted in `harness_instances`. */
export interface HarnessInstance {
  id: string
  harness_type: HarnessType
  label: string
  /** Home directory of this login: CLAUDE_CONFIG_DIR or CODEX_HOME. */
  home_path: string
  created_at: string
}

/** An instance as the settings screen shows it: whether its session history is shared with the default home. */
export interface HarnessInstanceView extends HarnessInstance {
  shares_history: boolean
}

export function isHarnessType(value: unknown): value is HarnessType {
  return value === 'claude-code' || value === 'codex'
}

/** Harness type behind an agent's `coding_agent` value, or null for harnesses without instances. */
export function harnessTypeOf(codingAgent: string | null | undefined): HarnessType | null {
  return isHarnessType(codingAgent) ? codingAgent : null
}

/** Name of a harness type as shown to the user. */
export function harnessTypeLabel(harness: string | null | undefined): string {
  switch (harness) {
    case 'claude-code': return 'Claude Code'
    case 'codex': return 'Codex'
    case 'opencode': return 'OpenCode'
    case 'cursor': return 'Cursor'
    case 'pi': return 'Pi'
    default: return 'agent'
  }
}

/**
 * Id of the implicit default instance of a usage provider. Stored on usage rows
 * and limit snapshots for every harness, so legacy rows map to the default.
 */
export function defaultHarnessInstanceId(provider: string): string {
  return `default:${provider}`
}

export function isDefaultHarnessInstanceId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith('default:')
}

/** Display label of the implicit default instance of a harness type. */
export function defaultHarnessInstanceLabel(harness: string): string {
  return harnessTypeLabel(harness)
}

/** Label of a stored instance, combining the harness name with the account label: "Codex · Work". */
export function harnessInstanceDisplayName(harness: string, label: string): string {
  return `${harnessTypeLabel(harness)} · ${label}`
}

export type ShellFlavor = 'posix' | 'powershell'

/** Environment variable that selects a harness instance's home directory. */
export function harnessHomeEnvName(harness: HarnessType): 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME' {
  return harness === 'claude-code' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'
}

/**
 * Command that signs an instance in, for the user to run in a terminal. 20x
 * never runs the login itself. The path is quoted for the chosen shell.
 */
export function signInCommand(harness: HarnessType, homePath: string, shell: ShellFlavor): string {
  const envName = harnessHomeEnvName(harness)
  const login = harness === 'claude-code' ? 'claude /login' : 'codex login'
  if (shell === 'powershell') {
    return `$env:${envName} = "${escapePowerShell(homePath)}"; ${login}`
  }
  return `${envName}="${escapePosix(homePath)}" ${login}`
}

function escapePosix(value: string): string {
  return value.replace(/(["\\$`])/g, '\\$1')
}

function escapePowerShell(value: string): string {
  return value.replace(/(["`$])/g, '`$1')
}

/**
 * Sort key for listing instances: defaults first, then by harness and label.
 */
export function compareHarnessInstances(
  a: { harness_type: string; label: string },
  b: { harness_type: string; label: string }
): number {
  if (a.harness_type !== b.harness_type) return a.harness_type.localeCompare(b.harness_type)
  return a.label.localeCompare(b.label)
}

/** Value of a harness dropdown option that stands for a stored account. */
export const HARNESS_INSTANCE_PREFIX = 'instance:'

/**
 * Harness dropdown options. A harness with stored accounts lists its default
 * first, then each account, e.g. "Codex", "Codex · Work". Other harnesses are
 * listed once. Accounts apply only to Claude Code and Codex.
 */
export function harnessDropdownOptions<T extends { value: string; label: string }>(
  instances: Array<{ id: string; harness_type: string; label: string }>,
  harnesses: readonly T[]
): Array<{ value: string; label: string }> {
  return harnesses.flatMap((harness) => {
    const accounts = isHarnessType(harness.value) ? instances.filter((i) => i.harness_type === harness.value) : []
    return [
      { value: harness.value, label: harness.label },
      ...accounts.map((i) => ({
        value: `${HARNESS_INSTANCE_PREFIX}${i.id}`,
        label: harnessInstanceDisplayName(i.harness_type, i.label)
      }))
    ]
  })
}
