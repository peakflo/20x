/**
 * Validation for user-supplied "local ACP command" agents: an arbitrary
 * executable plus literal argv entries plus env overrides, spawned with
 * `shell: false` so argument content can never be interpreted by a shell.
 */

import { access, constants } from 'fs/promises'
import { isAbsolute } from 'path'
import { commandExistsOnPath } from './registry-client'

export interface LocalAcpCommandConfig {
  executable: string
  args: string[]
  env: Record<string, string>
}

export interface LocalCommandValidationFailure {
  kind: 'empty-executable' | 'windows-script-wrapper' | 'not-found' | 'not-executable'
  message: string
}

/**
 * Executables ending in `.cmd`/`.bat` rely on `cmd.exe`'s shell-association
 * behavior to run at all. Spawning one directly with `shell: false` doesn't
 * reliably work, and turning shell mode on would reopen the argv-injection
 * surface this design exists to avoid — so these are rejected outright with
 * guidance to point at the real interpreter instead (e.g. `node.exe` plus
 * the script path as a literal extra argument).
 */
const WINDOWS_SCRIPT_WRAPPER_RE = /\.(cmd|bat)$/i

export async function validateLocalCommand(
  config: Pick<LocalAcpCommandConfig, 'executable'>
): Promise<LocalCommandValidationFailure | null> {
  const executable = config.executable.trim()
  if (!executable) {
    return { kind: 'empty-executable', message: 'An executable path or command name is required.' }
  }

  if (process.platform === 'win32' && WINDOWS_SCRIPT_WRAPPER_RE.test(executable)) {
    return {
      kind: 'windows-script-wrapper',
      message:
        'This points at a .cmd/.bat script wrapper, which cannot be run safely without a shell. ' +
        'Point this at the real interpreter instead (e.g. node.exe) and add the script path as an argument.'
    }
  }

  if (isAbsolute(executable) || executable.includes('/') || executable.includes('\\')) {
    const ok = await access(executable, constants.X_OK)
      .then(() => true)
      .catch(() => false)
    if (!ok) {
      return { kind: 'not-executable', message: `"${executable}" does not exist or is not executable.` }
    }
    return null
  }

  const onPath = await commandExistsOnPath(executable)
  if (!onPath) {
    return { kind: 'not-found', message: `"${executable}" was not found on PATH.` }
  }
  return null
}

/** Builds the literal spawn argv/env for a local command — never routed through a shell. */
export function buildLocalCommandSpawnArgs(config: LocalAcpCommandConfig): {
  command: string
  args: string[]
  env: Record<string, string>
  shell: false
} {
  return {
    command: config.executable,
    args: [...config.args],
    env: { ...config.env },
    shell: false
  }
}
