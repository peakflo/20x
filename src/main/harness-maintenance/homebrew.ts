/**
 * Homebrew "latest version" lookup via `brew info --json=v2`. Homebrew
 * consistently lags the npm registry by hours, so when a binary is proven to
 * be Homebrew-owned (see `installer-detect.ts`), this wins over the npm
 * registry value for that harness.
 */

import { execFile } from 'child_process'

const TIMEOUT_MS = 10000

export interface BrewExecLike {
  (cmd: string, args: string[], opts: { timeout: number }): Promise<{ stdout: string }>
}

const defaultBrewExec: BrewExecLike = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeout, windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve({ stdout })
    })
  })

interface BrewInfoV2 {
  formulae?: Array<{ versions?: { stable?: string } }>
  casks?: Array<{ version?: string }>
}

/** Strips a cask's build-number suffix, e.g. "1.2.3,456" -> "1.2.3". */
function stripCaskBuildSuffix(version: string): string {
  const comma = version.indexOf(',')
  return comma === -1 ? version : version.slice(0, comma)
}

/**
 * Looks up the latest version Homebrew reports for a formula or cask. Never
 * throws — returns null if `brew` isn't on PATH, the command times out, or
 * the output doesn't contain the expected entry.
 */
export async function fetchBrewLatestVersion(
  name: string,
  kind: 'formula' | 'cask',
  brewExec: BrewExecLike = defaultBrewExec
): Promise<string | null> {
  try {
    const { stdout } = await brewExec('brew', ['info', '--json=v2', name], { timeout: TIMEOUT_MS })
    const data = JSON.parse(stdout) as BrewInfoV2
    if (kind === 'cask') {
      const version = data.casks?.[0]?.version
      return version ? stripCaskBuildSuffix(version) : null
    }
    return data.formulae?.[0]?.versions?.stable ?? null
  } catch {
    return null
  }
}
