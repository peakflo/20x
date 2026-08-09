/**
 * Optional install of the local speech runtime.
 *
 * The runtime is a native package. It is not part of the application bundle,
 * because it must stay optional: a user who never turns voice on must not pay
 * for it in download size, and a missing runtime must never break a build or an
 * install of 20x itself.
 *
 * The package is installed into the application data directory, not into the
 * application bundle, which is read-only once the app is packaged. The worker
 * then loads it from that directory by absolute path.
 */

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, rm, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import type { VoiceRuntimeStatus } from '../../shared/voice'

/**
 * The Phase 0 packaging spike must replace this with an exact version once it
 * has proved the runtime on macOS arm64, macOS x64, Windows x64 and Linux x64.
 * The resolved version is always reported back, so a diagnostic report states
 * what is really installed.
 */
export const VOICE_RUNTIME_PACKAGE = 'sherpa-onnx-node'
export const VOICE_RUNTIME_SPEC = VOICE_RUNTIME_PACKAGE

/** Roughly how much disk the runtime and its platform binaries need. */
export const VOICE_RUNTIME_APPROX_BYTES = 180 * 1024 * 1024

export interface RuntimeProgress {
  stage: 'starting' | 'installing' | 'complete' | 'error'
  output: string
  percent: number
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

/** Where the runtime lives: `<userData>/voice-runtime`. */
export function runtimeModulePath(rootDir: string): string {
  return join(rootDir, 'node_modules', VOICE_RUNTIME_PACKAGE)
}

/** Reads what is installed. It never throws: voice must stay optional. */
export async function detectVoiceRuntime(rootDir: string): Promise<VoiceRuntimeStatus> {
  const modulePath = runtimeModulePath(rootDir)
  const manifest = join(modulePath, 'package.json')
  if (!existsSync(manifest)) {
    return { installed: false, version: null, modulePath: null, sizeBytes: VOICE_RUNTIME_APPROX_BYTES }
  }
  try {
    const parsed = JSON.parse(await readFile(manifest, 'utf8')) as { version?: string }
    return {
      installed: true,
      version: parsed.version ?? null,
      modulePath,
      sizeBytes: VOICE_RUNTIME_APPROX_BYTES,
    }
  } catch {
    return { installed: false, version: null, modulePath: null, sizeBytes: VOICE_RUNTIME_APPROX_BYTES }
  }
}

/** True when npm can be called. The install needs it. */
export async function isNpmAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(npmCommand(), ['--version'], {
      shell: process.platform === 'win32',
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      child.kill()
      resolve(false)
    }, 5000)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

/**
 * Installs the runtime into `rootDir`. Progress lines come straight from npm,
 * so the user can see what is happening and can read a real error.
 */
export async function installVoiceRuntime(
  rootDir: string,
  onProgress: (progress: RuntimeProgress) => void
): Promise<VoiceRuntimeStatus> {
  onProgress({ stage: 'starting', output: 'Preparing the download…\n', percent: 0 })

  if (!(await isNpmAvailable())) {
    const message =
      'npm was not found. Install Node.js first — 20x can install it from Settings → General.\n'
    onProgress({ stage: 'error', output: message, percent: 100 })
    throw new Error(message.trim())
  }

  await mkdir(rootDir, { recursive: true })
  // A private manifest keeps npm from walking up into the app directory.
  await writeFile(
    join(rootDir, 'package.json'),
    `${JSON.stringify({ name: '20x-voice-runtime', version: '1.0.0', private: true }, null, 2)}\n`,
    'utf8'
  )

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      npmCommand(),
      ['install', VOICE_RUNTIME_SPEC, '--omit=dev', '--no-audit', '--no-fund', '--loglevel=info'],
      { cwd: rootDir, shell: process.platform === 'win32', windowsHide: true }
    )

    // npm gives no percentage, so the bar moves towards 90 and finishes on exit.
    let percent = 5
    const bump = (chunk: Buffer): void => {
      percent = Math.min(90, percent + 3)
      onProgress({ stage: 'installing', output: chunk.toString(), percent })
    }
    child.stdout?.on('data', bump)
    child.stderr?.on('data', bump)

    child.on('error', (err) => reject(err))
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`npm exited with code ${code}. See the output above.`))
    })
  })

  const status = await detectVoiceRuntime(rootDir)
  if (!status.installed) {
    const message = 'The install finished but the runtime was not found.\n'
    onProgress({ stage: 'error', output: message, percent: 100 })
    throw new Error(message.trim())
  }
  onProgress({
    stage: 'complete',
    output: `Installed ${VOICE_RUNTIME_PACKAGE} ${status.version ?? ''}\n`,
    percent: 100,
  })
  return status
}

/** Deletes the runtime and gives the disk space back. */
export async function removeVoiceRuntime(rootDir: string): Promise<void> {
  await rm(rootDir, { recursive: true, force: true })
}
