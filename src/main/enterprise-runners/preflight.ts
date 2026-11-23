import {
  satisfiesNodeRange,
  type ConnectFailure,
  type PreflightCheck,
  type PreflightResult
} from '../../shared/enterprise-runners'
import type { EnterpriseRunnersApi } from './api-client'
import { buildCleanEnv } from './clean-env'

export interface CommandResult {
  ok: boolean
  stdout: string
}
export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>

export interface PreflightDeps {
  platform: NodeJS.Platform
  arch: string
  /** e.g. "15.1" — only used for display. */
  osVersion?: string
  run: CommandRunner
  api: Pick<EnterpriseRunnersApi, 'getHarnessVersion' | 'getApiUrl'>
  isSignedIn: () => Promise<boolean>
}

const OS_NAMES: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }

/** Pre-install check shown before "Connect": OS, Node (engines), Git, signed in. */
export async function runPreflight(deps: PreflightDeps): Promise<PreflightResult> {
  const checks: PreflightCheck[] = []
  let failure: ConnectFailure | null = null
  const fail = (value: ConnectFailure): void => {
    failure = failure ?? value
  }

  const osName = OS_NAMES[deps.platform] ?? deps.platform
  const supported = deps.platform === 'darwin' || deps.platform === 'linux'
  checks.push({
    id: 'os',
    ok: supported,
    detail: [osName, deps.osVersion, deps.arch].filter(Boolean).join(' '),
    help: supported ? undefined : 'Runners need macOS or Linux.'
  })
  if (!supported) {
    fail({ kind: 'unsupported_os', message: 'Runners need macOS or Linux. Use a Mac/Linux machine or a shared runner.' })
  }

  let pinnedVersion: string | null = null
  let nodeEngines: string | null = null
  let versionError: string | null = null
  const signedIn = await deps.isSignedIn()
  checks.push({
    id: 'signed_in',
    ok: signedIn,
    detail: signedIn ? 'Signed in to Peakflo Enterprise' : 'Not signed in',
    help: signedIn ? undefined : 'Sign in under Settings → Enterprise.'
  })
  if (!signedIn) {
    fail({ kind: 'not_signed_in', message: 'Sign in to Peakflo Enterprise first.' })
  } else {
    try {
      const info = await deps.api.getHarnessVersion()
      pinnedVersion = info.version
      nodeEngines = info.nodeEngines
      if (!pinnedVersion) {
        versionError = 'The server has not published a harness version yet. Try again later.'
        fail({ kind: 'version_unavailable', message: versionError })
      }
    } catch (error) {
      versionError = `Could not read the server's harness version: ${error instanceof Error ? error.message : String(error)}`
      fail({ kind: 'version_unavailable', message: versionError })
    }
  }

  const node = await deps.run('node', ['--version'])
  const nodeVersion = node.ok ? node.stdout.trim().replace(/^v/, '') : ''
  if (!nodeVersion) {
    const help = deps.platform === 'darwin' ? 'brew install node' : 'Install Node.js from nodejs.org'
    checks.push({ id: 'node', ok: false, detail: `Node${nodeEngines ? ` (needs ${nodeEngines})` : ''} — none found`, help })
    fail({ kind: 'node_missing', message: 'Node.js was not found.', help })
  } else if (!satisfiesNodeRange(nodeVersion, nodeEngines)) {
    const help = deps.platform === 'darwin' ? 'brew upgrade node' : 'Install a newer Node.js from nodejs.org'
    checks.push({ id: 'node', ok: false, detail: `Node ${nodeVersion} — needs ${nodeEngines}`, help })
    fail({ kind: 'node_missing', message: `Node ${nodeVersion} is too old (needs ${nodeEngines}).`, help })
  } else {
    checks.push({ id: 'node', ok: true, detail: `Node ${nodeVersion}` })
  }

  const git = await deps.run('git', ['--version'])
  const gitVersion = git.ok ? /(\d+\.\d+(?:\.\d+)?)/.exec(git.stdout)?.[1] : null
  if (!gitVersion) {
    const help = deps.platform === 'darwin' ? 'xcode-select --install' : 'Install Git with your package manager'
    checks.push({ id: 'git', ok: false, detail: 'Git — none found', help })
    fail({ kind: 'git_missing', message: 'Git was not found.', help })
  } else {
    checks.push({ id: 'git', ok: true, detail: `Git ${gitVersion}` })
  }

  return { ok: failure === null, checks, versionError, pinnedVersion, nodeEngines, controlPlane: deps.api.getApiUrl(), failure }
}

/** Default runner: fixed command, fixed args, scrubbed env, short timeout, never rejects. */
export function createCommandRunner(execFile: typeof import('node:child_process').execFile): CommandRunner {
  return (command, args) =>
    new Promise<CommandResult>((resolve) => {
      try {
        execFile(command, args, { env: buildCleanEnv(), timeout: 8000, windowsHide: true }, (error, stdout) => {
          resolve({ ok: !error, stdout: String(stdout ?? '') })
        })
      } catch {
        resolve({ ok: false, stdout: '' })
      }
    })
}
