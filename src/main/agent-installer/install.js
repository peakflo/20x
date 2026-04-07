import { spawn, execFile } from 'child_process'
import { createWriteStream, mkdirSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { detectInstalledAgents } from './detect.js'

/**
 * Install commands per agent (npm-based tools).
 * @type {Record<string, { cmd: string, args: string[] } | null>}
 */
const INSTALL_COMMANDS = {
  claudeCode: { cmd: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'] },
  opencode: { cmd: 'npm', args: ['install', '-g', 'opencode-ai'] },
  codex: { cmd: 'npm', args: ['install', '-g', '@openai/codex'] },
  pnpm: { cmd: 'npm', args: ['install', '-g', 'pnpm'] },
  gh: null,
  glab: null,
  nodejs: null,
  git: null
}

/**
 * Get the display install command for a given agent.
 * @param {string} agentName
 * @returns {string}
 */
export function getInstallCommand(agentName) {
  if (agentName === 'gh') {
    if (process.platform === 'win32') return 'winget install --id GitHub.cli -e'
    if (process.platform === 'darwin') return 'brew install gh'
    return 'See https://cli.github.com/manual/installation'
  }
  if (agentName === 'glab') {
    if (process.platform === 'win32') return 'winget install --id GLab.GLab -e'
    if (process.platform === 'darwin') return 'brew install glab'
    return 'See https://gitlab.com/gitlab-org/cli#installation'
  }
  if (agentName === 'nodejs') return 'Downloads and installs Node.js automatically'
  if (agentName === 'git') return 'Downloads and installs Git automatically'
  const info = INSTALL_COMMANDS[agentName]
  if (!info) return `Unknown agent: ${agentName}`
  return `${info.cmd} ${info.args.join(' ')}`
}

/**
 * Download a file from a URL to a local path.
 * Uses Electron's net module for proxy-aware downloads.
 * @param {string} url
 * @param {string} destPath
 * @param {(progress: { stage: string, output: string, percent: number }) => void} onProgress
 * @returns {Promise<void>}
 */
async function downloadFile(url, destPath, onProgress) {
  const { net } = await import('electron')

  return new Promise((resolve, reject) => {
    const request = net.request(url)

    request.on('response', (response) => {
      // Follow redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirectUrl = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location
        onProgress({ stage: 'installing', output: `Redirecting...\n`, percent: 10 })
        downloadFile(redirectUrl, destPath, onProgress).then(resolve).catch(reject)
        return
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${response.statusCode}`))
        return
      }

      const contentLength = parseInt(response.headers['content-length']?.[0] || response.headers['content-length'] || '0', 10)
      let downloaded = 0

      const file = createWriteStream(destPath)

      response.on('data', (chunk) => {
        file.write(chunk)
        downloaded += chunk.length
        if (contentLength > 0) {
          const pct = Math.round((downloaded / contentLength) * 60) + 10
          onProgress({ stage: 'installing', output: `Downloaded ${(downloaded / 1024 / 1024).toFixed(1)} MB\r`, percent: Math.min(pct, 70) })
        }
      })

      response.on('end', () => {
        file.end()
        file.on('finish', () => resolve())
      })

      response.on('error', (err) => {
        file.destroy()
        reject(err)
      })
    })

    request.on('error', (err) => reject(err))
    request.end()
  })
}

/**
 * Run an installer executable (MSI/EXE) with optional elevation.
 * @param {string} installerPath
 * @param {string[]} args
 * @param {string} agentName
 * @param {(progress: { stage: string, output: string, percent: number }) => void} onProgress
 * @returns {Promise<{ success: boolean, error: string | null }>}
 */
function runInstaller(installerPath, args, agentName, onProgress) {
  return new Promise((resolve) => {
    onProgress({ stage: 'installing', output: `Running installer...\n`, percent: 75 })

    // Use PowerShell Start-Process with -Verb RunAs for UAC elevation.
    // Store the process in a variable and call WaitForExit() explicitly
    // to avoid "Process must exit before requested information" errors
    // that occur when piping -PassThru to Select-Object with UAC elevation.
    const psArgs = [
      '-NoProfile', '-Command',
      `$p = Start-Process -FilePath '${installerPath}' -ArgumentList @(${args.map(a => `'${a}'`).join(',')}) -Verb RunAs -PassThru; $p.WaitForExit(); exit $p.ExitCode`
    ]

    const proc = spawn('powershell.exe', psArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false
    })

    let output = ''

    proc.stdout?.on('data', (chunk) => {
      output += chunk.toString()
      onProgress({ stage: 'installing', output: chunk.toString(), percent: 85 })
    })

    proc.stderr?.on('data', (chunk) => {
      output += chunk.toString()
      onProgress({ stage: 'installing', output: chunk.toString(), percent: 85 })
    })

    proc.on('error', (err) => {
      resolve({ success: false, error: err.message })
    })

    proc.on('close', (code) => {
      if (code === 0 || code === 3010) { // 3010 = success, reboot required
        resolve({ success: true, error: null })
      } else {
        resolve({ success: false, error: `Installer exited with code ${code}` })
      }
    })
  })
}

/**
 * Resolve the latest Node.js LTS download URL dynamically.
 * Falls back to a known-good version if the API call fails.
 */
async function resolveNodejsUrl() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  try {
    const resp = await (await import('electron')).net.fetch('https://nodejs.org/dist/index.json', { signal: AbortSignal.timeout(8000) })
    if (resp.ok) {
      const releases = await resp.json()
      const lts = releases.find(r => r.lts)
      if (lts) {
        const ver = lts.version // e.g. "v22.16.0"
        return `https://nodejs.org/dist/${ver}/node-${ver}-${arch}.msi`
      }
    }
  } catch { /* fall through to fallback */ }
  return `https://nodejs.org/dist/latest-lts/node-latest-lts-${arch}.msi`
}

/**
 * Install Node.js on Windows by downloading the MSI installer.
 */
async function installNodejs(onProgress) {
  const isWin = process.platform === 'win32'
  if (!isWin) {
    return {
      success: false,
      error: 'Automatic Node.js installation is only supported on Windows. Please install from https://nodejs.org/',
      newStatus: await detectInstalledAgents()
    }
  }

  onProgress({ stage: 'starting', output: 'Downloading Node.js installer...\n', percent: 5 })

  const downloadDir = join(tmpdir(), '20x-installers')
  if (!existsSync(downloadDir)) mkdirSync(downloadDir, { recursive: true })

  const msiPath = join(downloadDir, 'nodejs-install.msi')

  try {
    const nodeUrl = await resolveNodejsUrl()
    onProgress({ stage: 'installing', output: `Downloading from nodejs.org...\n`, percent: 10 })
    await downloadFile(nodeUrl, msiPath, onProgress)

    onProgress({ stage: 'installing', output: 'Download complete. Starting installer (you may see a UAC prompt)...\n', percent: 70 })

    // Run MSI with silent install + add to PATH
    const result = await runInstaller('msiexec.exe', ['/i', msiPath, '/qn', '/norestart', 'ADDLOCAL=ALL'], 'nodejs', onProgress)

    // Clean up
    try { unlinkSync(msiPath) } catch { /* ignore */ }

    if (result.success) {
      onProgress({ stage: 'complete', output: 'Node.js installed successfully! npm is included.\n', percent: 100 })
    } else {
      onProgress({ stage: 'error', output: `Installation failed: ${result.error}\n`, percent: 100 })
    }

    return { success: result.success, error: result.error, newStatus: await detectInstalledAgents() }
  } catch (err) {
    try { unlinkSync(msiPath) } catch { /* ignore */ }
    onProgress({ stage: 'error', output: `Error: ${err.message}\n`, percent: 100 })
    return { success: false, error: err.message, newStatus: await detectInstalledAgents() }
  }
}

/**
 * Resolve the latest Git for Windows download URL dynamically.
 * Falls back to the GitHub releases redirect if the API call fails.
 */
async function resolveGitUrl() {
  const suffix = process.arch === 'arm64' ? 'arm64.exe' : '64-bit.exe'
  try {
    const resp = await (await import('electron')).net.fetch(
      'https://api.github.com/repos/git-for-windows/git/releases/latest',
      { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': '20x-app' } }
    )
    if (resp.ok) {
      const release = await resp.json()
      const asset = release.assets?.find(a => a.name.endsWith(suffix) && !a.name.includes('busybox'))
      if (asset?.browser_download_url) return asset.browser_download_url
    }
  } catch { /* fall through to fallback */ }
  // Fallback: GitHub will redirect to the latest release asset
  return `https://github.com/git-for-windows/git/releases/latest/download/Git-64-bit.exe`
}

/**
 * Install Git on Windows by downloading the installer.
 */
async function installGit(onProgress) {
  const isWin = process.platform === 'win32'
  if (!isWin) {
    return {
      success: false,
      error: 'Automatic Git installation is only supported on Windows. Please install from https://git-scm.com/',
      newStatus: await detectInstalledAgents()
    }
  }

  onProgress({ stage: 'starting', output: 'Downloading Git installer...\n', percent: 5 })

  const downloadDir = join(tmpdir(), '20x-installers')
  if (!existsSync(downloadDir)) mkdirSync(downloadDir, { recursive: true })

  const exePath = join(downloadDir, 'git-install.exe')

  try {
    const gitUrl = await resolveGitUrl()
    onProgress({ stage: 'installing', output: `Downloading from git-scm.com...\n`, percent: 10 })
    await downloadFile(gitUrl, exePath, onProgress)

    onProgress({ stage: 'installing', output: 'Download complete. Starting installer (you may see a UAC prompt)...\n', percent: 70 })

    // Run Git installer silently
    const result = await runInstaller(exePath, ['/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/CLOSEAPPLICATIONS', '/RESTARTAPPLICATIONS', '/COMPONENTS=icons,ext,ext\\shellhere,ext\\guihere,gitlfs,assoc,assoc_sh'], 'git', onProgress)

    // Clean up
    try { unlinkSync(exePath) } catch { /* ignore */ }

    if (result.success) {
      onProgress({ stage: 'complete', output: 'Git installed successfully!\n', percent: 100 })
    } else {
      onProgress({ stage: 'error', output: `Installation failed: ${result.error}\n`, percent: 100 })
    }

    return { success: result.success, error: result.error, newStatus: await detectInstalledAgents() }
  } catch (err) {
    try { unlinkSync(exePath) } catch { /* ignore */ }
    onProgress({ stage: 'error', output: `Error: ${err.message}\n`, percent: 100 })
    return { success: false, error: err.message, newStatus: await detectInstalledAgents() }
  }
}

/**
 * Install an agent CLI tool.
 * @param {string} agentName - One of 'claudeCode', 'opencode', 'codex', 'pnpm', 'gh', 'nodejs', 'git'
 * @param {(progress: { stage: string, output: string, percent: number }) => void} onProgress
 * @returns {Promise<{ success: boolean, error: string | null, newStatus: object }>}
 */
export async function installAgent(agentName, onProgress) {
  const isWin = process.platform === 'win32'

  // Node.js — download MSI installer
  if (agentName === 'nodejs') {
    return installNodejs(onProgress)
  }

  // Git — download installer
  if (agentName === 'git') {
    return installGit(onProgress)
  }

  // npm — bundled with Node.js, install Node.js instead
  if (agentName === 'npm') {
    onProgress({ stage: 'starting', output: 'npm is bundled with Node.js. Installing Node.js...\n', percent: 0 })
    return installNodejs(onProgress)
  }

  // GitHub CLI — special case
  if (agentName === 'gh') {
    if (isWin) {
      return spawnInstall('winget', ['install', '--id', 'GitHub.cli', '-e', '--accept-source-agreements', '--accept-package-agreements'], agentName, onProgress)
    }
    return {
      success: false,
      error: 'GitHub CLI must be installed manually on this platform. See https://cli.github.com/',
      newStatus: await detectInstalledAgents()
    }
  }

  // GitLab CLI — special case
  if (agentName === 'glab') {
    if (isWin) {
      return spawnInstall('winget', ['install', '--id', 'GLab.GLab', '-e', '--accept-source-agreements', '--accept-package-agreements'], agentName, onProgress)
    }
    return {
      success: false,
      error: 'GitLab CLI must be installed manually on this platform. See https://gitlab.com/gitlab-org/cli#installation',
      newStatus: await detectInstalledAgents()
    }
  }

  const info = INSTALL_COMMANDS[agentName]
  if (!info) {
    return {
      success: false,
      error: `Unknown agent: ${agentName}`,
      newStatus: await detectInstalledAgents()
    }
  }

  // Check if npm is available before attempting npm installs
  try {
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    await execFileAsync(isWin ? 'npm.cmd' : 'npm', ['--version'], { timeout: 5000, shell: isWin, windowsHide: true })
  } catch {
    onProgress({ stage: 'error', output: 'npm is not installed. Please install Node.js first (it includes npm).\n', percent: 100 })
    return {
      success: false,
      error: 'npm is not installed. Install Node.js first.',
      newStatus: await detectInstalledAgents()
    }
  }

  // On Windows, npm is invoked as npm.cmd
  const cmd = isWin ? `${info.cmd}.cmd` : info.cmd
  return spawnInstall(cmd, info.args, agentName, onProgress)
}

/**
 * Spawn an install process and stream output.
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} agentName
 * @param {(progress: { stage: string, output: string, percent: number }) => void} onProgress
 * @returns {Promise<{ success: boolean, error: string | null, newStatus: object }>}
 */
function spawnInstall(cmd, args, agentName, onProgress) {
  return new Promise((resolve) => {
    onProgress({ stage: 'starting', output: `$ ${cmd} ${args.join(' ')}\n`, percent: 0 })

    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
    })

    let output = ''

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      output += text
      onProgress({ stage: 'installing', output: text, percent: 50 })
    })

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      output += text
      onProgress({ stage: 'installing', output: text, percent: 50 })
    })

    proc.on('error', async (err) => {
      onProgress({ stage: 'error', output: `Error: ${err.message}\n`, percent: 100 })
      resolve({
        success: false,
        error: err.message,
        newStatus: await detectInstalledAgents()
      })
    })

    proc.on('close', async (code) => {
      const newStatus = await detectInstalledAgents()
      if (code === 0) {
        onProgress({ stage: 'complete', output: 'Installation complete.\n', percent: 100 })
        resolve({ success: true, error: null, newStatus })
      } else {
        onProgress({ stage: 'error', output: `Process exited with code ${code}\n`, percent: 100 })
        resolve({
          success: false,
          error: `Install failed with exit code ${code}`,
          newStatus
        })
      }
    })
  })
}
