/**
 * Manages marimo notebook server instances.
 *
 * When the agent writes a .py file that contains `import marimo`,
 * we spin up `marimo run --headless --no-token --port <port> <file>`
 * and expose the URL so the renderer can embed it in an iframe.
 */
import { spawn, execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, readFileSync } from 'fs'
import type { ChildProcess } from 'child_process'

const execFileAsync = promisify(execFile)

interface MarimoInstance {
  port: number
  process: ChildProcess
  filePath: string
  url: string
}

// Track all running marimo instances by file path
const instances = new Map<string, MarimoInstance>()
let marimoPath: string | null = null
let marimoChecked = false

/**
 * Check if marimo is installed and return its path
 */
export async function checkMarimo(): Promise<{ installed: boolean; path: string | null; version: string | null }> {
  if (marimoChecked && marimoPath) {
    return { installed: true, path: marimoPath, version: null }
  }

  // Try common locations
  const candidates = ['marimo', '/usr/local/bin/marimo', '/opt/homebrew/bin/marimo']

  // Also check if it's in a pipx or pip --user location
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (home) {
    candidates.push(`${home}/.local/bin/marimo`)
    candidates.push(`${home}/Library/Python/3.11/bin/marimo`)
    candidates.push(`${home}/Library/Python/3.12/bin/marimo`)
    candidates.push(`${home}/Library/Python/3.13/bin/marimo`)
  }

  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate, ['--version'], { timeout: 5000 })
      marimoPath = candidate
      marimoChecked = true
      const version = stdout.trim().replace('marimo ', '')
      console.log(`[marimo] Found marimo at ${candidate} (v${version})`)
      return { installed: true, path: candidate, version }
    } catch {
      // Not found at this path, try next
    }
  }

  marimoChecked = true
  return { installed: false, path: null, version: null }
}

/**
 * Detect whether a .py file is a marimo notebook
 */
export function isMarimoNotebook(filePath: string): boolean {
  if (!filePath.endsWith('.py')) return false
  if (!existsSync(filePath)) return false

  try {
    // Read first 2KB to check for marimo markers
    const content = readFileSync(filePath, 'utf-8').slice(0, 2048)
    return (
      content.includes('import marimo') ||
      content.includes('marimo.App') ||
      content.includes('@app.cell')
    )
  } catch {
    return false
  }
}

/**
 * Find a free port in a range
 */
function getRandomPort(): number {
  return 2718 + Math.floor(Math.random() * 1000)
}

/**
 * Launch a marimo server for a notebook file.
 * Returns the URL to embed in an iframe.
 */
export async function launchMarimo(
  filePath: string,
  mode: 'run' | 'edit' = 'run'
): Promise<{ url: string; port: number; pid: number }> {
  // If already running for this file, return existing
  const existing = instances.get(filePath)
  if (existing) {
    return { url: existing.url, port: existing.port, pid: existing.process.pid! }
  }

  const marimoStatus = await checkMarimo()
  if (!marimoStatus.installed || !marimoStatus.path) {
    throw new Error('marimo is not installed. Install it with: pip install marimo')
  }

  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }

  const port = getRandomPort()
  const args = [
    mode,
    '--headless',
    '--no-token',
    '--port', String(port),
    '--host', '127.0.0.1',
    filePath
  ]

  console.log(`[marimo] Launching: ${marimoStatus.path} ${args.join(' ')}`)

  const proc = spawn(marimoStatus.path, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })

  const url = `http://127.0.0.1:${port}`

  const instance: MarimoInstance = {
    port,
    process: proc,
    filePath,
    url,
  }

  instances.set(filePath, instance)

  // Log output for debugging
  proc.stdout?.on('data', (data: Buffer) => {
    console.log(`[marimo:${port}] ${data.toString().trim()}`)
  })
  proc.stderr?.on('data', (data: Buffer) => {
    console.log(`[marimo:${port}:err] ${data.toString().trim()}`)
  })

  // Clean up on exit
  proc.on('exit', (code) => {
    console.log(`[marimo:${port}] Process exited with code ${code}`)
    instances.delete(filePath)
  })

  // Wait for the server to be ready by polling
  await waitForServer(url, 15000)

  console.log(`[marimo] Server ready at ${url} (pid: ${proc.pid})`)
  return { url, port, pid: proc.pid! }
}

/**
 * Stop a marimo server instance
 */
export function stopMarimo(filePath: string): boolean {
  const instance = instances.get(filePath)
  if (!instance) return false

  console.log(`[marimo] Stopping server for ${filePath} (pid: ${instance.process.pid})`)
  instance.process.kill('SIGTERM')
  instances.delete(filePath)
  return true
}

/**
 * Stop all running marimo instances (call on app quit)
 */
export function stopAllMarimo(): void {
  for (const [filePath, instance] of instances) {
    console.log(`[marimo] Stopping server for ${filePath}`)
    instance.process.kill('SIGTERM')
  }
  instances.clear()
}

/**
 * Get status of a running marimo instance
 */
export function getMarimoStatus(filePath: string): { running: boolean; url: string | null; port: number | null } {
  const instance = instances.get(filePath)
  if (!instance) return { running: false, url: null, port: null }
  return { running: true, url: instance.url, port: instance.port }
}

/**
 * Poll a URL until it responds (server startup)
 */
async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (response.ok || response.status === 200) return
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  // Don't throw — server may still be starting, let the iframe handle it
  console.log(`[marimo] Server at ${url} did not respond within ${timeoutMs}ms, proceeding anyway`)
}
