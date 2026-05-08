import { spawn, execFile } from 'child_process'
import { createWriteStream, mkdirSync, existsSync, unlinkSync, rmSync, symlinkSync, copyFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { detectInstalledAgents } from './detect.js'

/**
 * Ensure a directory is on the running process's PATH so subsequently
 * spawned child processes can find binaries placed there.
 * Returns true if PATH was modified.
 */
function ensureOnPath(dir) {
  const sep = process.platform === 'win32' ? ';' : ':'
  const pathEnv = process.env.PATH || ''
  const segments = pathEnv.split(sep)
  if (segments.includes(dir) || segments.includes(`${dir}/`)) return false
  process.env.PATH = `${dir}${sep}${pathEnv}`
  return true
}

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
  const isWin = process.platform === 'win32'
  const isMac = process.platform === 'darwin'
  const isLinux = process.platform === 'linux'

  if (agentName === 'gh') {
    if (isWin) return 'winget install --id GitHub.cli -e'
    if (isMac) return 'Downloads gh .pkg from GitHub releases'
    if (isLinux) return 'Downloads gh tarball → ~/.local/bin'
    return 'See https://cli.github.com/manual/installation'
  }
  if (agentName === 'glab') {
    if (isWin) return 'winget install --id GLab.GLab -e'
    if (isMac) return 'Downloads glab from GitLab releases'
    if (isLinux) return 'Downloads glab tarball → ~/.local/bin'
    return 'See https://gitlab.com/gitlab-org/cli#installation'
  }
  if (agentName === 'nodejs') {
    if (isWin || isMac) return 'Downloads and installs Node.js automatically'
    if (isLinux) return 'Downloads Node.js tarball → ~/.local/share/20x/node'
    return 'Install Node.js from https://nodejs.org/'
  }
  if (agentName === 'git') {
    if (isWin) return 'Downloads and installs Git automatically'
    if (isMac) return 'Triggers Xcode Command Line Tools install (includes Git)'
    if (isLinux) return 'Installs git via system package manager (admin prompt)'
    return 'Install Git from https://git-scm.com/'
  }
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
 * Run a Windows installer (MSI/EXE) elevated via UAC.
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
 * Run a macOS .pkg installer with admin privileges via osascript.
 * Shows the native macOS admin password prompt.
 * @param {string} pkgPath
 * @param {(progress: { stage: string, output: string, percent: number }) => void} onProgress
 * @returns {Promise<{ success: boolean, error: string | null }>}
 */
function runMacPkgInstaller(pkgPath, onProgress) {
  return new Promise((resolve) => {
    onProgress({ stage: 'installing', output: `Running pkg installer (you may see an admin prompt)...\n`, percent: 75 })

    // osascript admin prompt → installer -pkg <pkg> -target /
    // Escape quotes in path
    const safePath = pkgPath.replace(/"/g, '\\"')
    const script = `do shell script "installer -pkg \\"${safePath}\\" -target /" with administrator privileges`

    const proc = spawn('osascript', ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let output = ''
    let stderr = ''

    proc.stdout?.on('data', (chunk) => {
      const text = chunk.toString()
      output += text
      onProgress({ stage: 'installing', output: text, percent: 85 })
    })

    proc.stderr?.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      onProgress({ stage: 'installing', output: text, percent: 85 })
    })

    proc.on('error', (err) => {
      resolve({ success: false, error: err.message })
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, error: null })
      } else {
        // osascript exit code 1 with "User canceled" message = user cancelled prompt
        const error = stderr.includes('User canceled')
          ? 'Installation cancelled by user'
          : `Installer exited with code ${code}: ${stderr.trim() || output.trim()}`
        resolve({ success: false, error })
      }
    })
  })
}

/**
 * Resolve the latest Node.js LTS download URL dynamically per platform.
 * Returns { url, version } where version is e.g. "v22.20.0" (used by Linux
 * to derive the extracted folder name).
 * Falls back to a known-good version if the API call fails.
 */
async function resolveNodejsUrl() {
  const isWin = process.platform === 'win32'
  const isMac = process.platform === 'darwin'
  const isLinux = process.platform === 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'

  const buildAsset = (ver) => {
    if (isMac) return `node-${ver}-${arch}.pkg`
    if (isWin) return `node-${ver}-${arch}.msi`
    if (isLinux) return `node-${ver}-linux-${arch}.tar.xz`
    return `node-${ver}-${arch}.msi`
  }

  try {
    const resp = await (await import('electron')).net.fetch('https://nodejs.org/dist/index.json', { signal: AbortSignal.timeout(8000) })
    if (resp.ok) {
      const releases = await resp.json()
      const lts = releases.find(r => r.lts)
      if (lts) {
        const ver = lts.version // e.g. "v22.16.0"
        return { url: `https://nodejs.org/dist/${ver}/${buildAsset(ver)}`, version: ver }
      }
    }
  } catch { /* fall through to fallback */ }
  // Fallback: known-recent LTS
  const fallback = 'v22.20.0'
  return { url: `https://nodejs.org/dist/${fallback}/${buildAsset(fallback)}`, version: fallback }
}

/**
 * Install Node.js on Linux by extracting the tarball to ~/.local/share/20x/node
 * and symlinking node/npm/npx into ~/.local/bin (no sudo required).
 */
async function installNodejsLinux(onProgress) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const home = homedir()
  const installRoot = join(home, '.local', 'share', '20x', 'node')
  const binDir = join(home, '.local', 'bin')

  const downloadDir = join(tmpdir(), '20x-installers')
  if (!existsSync(downloadDir)) mkdirSync(downloadDir, { recursive: true })
  const tarPath = join(downloadDir, 'nodejs-install.tar.xz')

  try {
    onProgress({ stage: 'starting', output: 'Resolving latest Node.js LTS...\n', percent: 5 })
    const { url, version } = await resolveNodejsUrl()
    const extractedFolder = `node-${version}-linux-${arch}` // matches archive top-level dir

    onProgress({ stage: 'installing', output: `Downloading from nodejs.org...\n`, percent: 10 })
    await downloadFile(url, tarPath, onProgress)

    onProgress({ stage: 'installing', output: 'Extracting tarball...\n', percent: 70 })
    if (!existsSync(installRoot)) mkdirSync(installRoot, { recursive: true })

    // Wipe any prior extracted folder of the same version
    const extractedPath = join(installRoot, extractedFolder)
    try { rmSync(extractedPath, { recursive: true, force: true }) } catch { /* ignore */ }

    await new Promise((resolve, reject) => {
      const tar = spawn('tar', ['-xJf', tarPath, '-C', installRoot], { stdio: ['ignore', 'pipe', 'pipe'] })
      let err = ''
      tar.stderr?.on('data', (c) => { err += c.toString() })
      tar.on('error', reject)
      tar.on('close', (code) => code === 0 ? resolve() : reject(new Error(`tar exited with ${code}: ${err.trim()}`)))
    })

    if (!existsSync(extractedPath)) {
      throw new Error(`Extracted folder not found at ${extractedPath}`)
    }

    onProgress({ stage: 'installing', output: 'Symlinking node/npm/npx into ~/.local/bin...\n', percent: 90 })
    if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true })

    for (const binary of ['node', 'npm', 'npx']) {
      const target = join(extractedPath, 'bin', binary)
      const link = join(binDir, binary)
      try { unlinkSync(link) } catch { /* ignore if missing */ }
      symlinkSync(target, link)
    }

    try { unlinkSync(tarPath) } catch { /* ignore */ }

    // Inject binDir into this process's PATH so subsequent installs in the
    // same 20x session (npm-based: claudeCode, opencode, codex, pnpm) can
    // find npm without requiring a 20x restart. Returns true if PATH was
    // missing — implies user's shell rc probably also lacks it.
    const pathWasMissing = ensureOnPath(binDir)

    if (pathWasMissing) {
      onProgress({
        stage: 'complete',
        output: `Node.js ${version} installed.\nNOTE: ${binDir} is not on your shell PATH. Add this to ~/.bashrc or ~/.zshrc:\n  export PATH="$HOME/.local/bin:$PATH"\nThen reopen your terminal. (20x has injected it for this session so subsequent installs will work.)\n`,
        percent: 100
      })
    } else {
      onProgress({ stage: 'complete', output: `Node.js ${version} installed successfully!\n`, percent: 100 })
    }

    return { success: true, error: null, newStatus: await detectInstalledAgents() }
  } catch (err) {
    try { unlinkSync(tarPath) } catch { /* ignore */ }
    onProgress({ stage: 'error', output: `Error: ${err.message}\n`, percent: 100 })
    return { success: false, error: err.message, newStatus: await detectInstalledAgents() }
  }
}

/**
 * Install Node.js by downloading the platform installer.
 * Supports Windows (.msi), macOS (.pkg), and Linux (tarball → ~/.local).
 */
async function installNodejs(onProgress) {
  const isWin = process.platform === 'win32'
  const isMac = process.platform === 'darwin'
  const isLinux = process.platform === 'linux'

  if (isLinux) {
    return installNodejsLinux(onProgress)
  }

  if (!isWin && !isMac) {
    return {
      success: false,
      error: 'Automatic Node.js installation is only supported on Windows, macOS, and Linux. Please install from https://nodejs.org/',
      newStatus: await detectInstalledAgents()
    }
  }

  onProgress({ stage: 'starting', output: 'Downloading Node.js installer...\n', percent: 5 })

  const downloadDir = join(tmpdir(), '20x-installers')
  if (!existsSync(downloadDir)) mkdirSync(downloadDir, { recursive: true })

  const ext = isMac ? 'pkg' : 'msi'
  const installerPath = join(downloadDir, `nodejs-install.${ext}`)

  try {
    const { url: nodeUrl } = await resolveNodejsUrl()
    onProgress({ stage: 'installing', output: `Downloading from nodejs.org...\n`, percent: 10 })
    await downloadFile(nodeUrl, installerPath, onProgress)

    let result
    if (isMac) {
      onProgress({ stage: 'installing', output: 'Download complete. Starting installer (you may see an admin prompt)...\n', percent: 70 })
      result = await runMacPkgInstaller(installerPath, onProgress)
    } else {
      onProgress({ stage: 'installing', output: 'Download complete. Starting installer (you may see a UAC prompt)...\n', percent: 70 })
      result = await runInstaller('msiexec.exe', ['/i', installerPath, '/qn', '/norestart', 'ADDLOCAL=ALL'], 'nodejs', onProgress)
    }

    // Clean up
    try { unlinkSync(installerPath) } catch { /* ignore */ }

    if (result.success) {
      onProgress({ stage: 'complete', output: 'Node.js installed successfully! npm is included.\n', percent: 100 })
    } else {
      onProgress({ stage: 'error', output: `Installation failed: ${result.error}\n`, percent: 100 })
    }

    return { success: result.success, error: result.error, newStatus: await detectInstalledAgents() }
  } catch (err) {
    try { unlinkSync(installerPath) } catch { /* ignore */ }
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
 * Install Git on macOS by triggering Xcode Command Line Tools install.
 * This shows the native macOS GUI prompt to install CLT (which includes git).
 */
async function installGitMac(onProgress) {
  return new Promise((resolve) => {
    onProgress({ stage: 'starting', output: 'Triggering Xcode Command Line Tools install...\n', percent: 5 })
    onProgress({ stage: 'installing', output: 'A macOS dialog will appear. Click "Install" to install Git via Command Line Tools.\nThis may take several minutes.\n', percent: 20 })

    // xcode-select --install triggers the native installer GUI dialog and exits immediately.
    // The actual install runs in the background managed by the OS.
    const proc = spawn('xcode-select', ['--install'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stderr = ''
    proc.stderr?.on('data', (chunk) => { stderr += chunk.toString() })

    proc.on('error', async (err) => {
      onProgress({ stage: 'error', output: `Error: ${err.message}\n`, percent: 100 })
      resolve({ success: false, error: err.message, newStatus: await detectInstalledAgents() })
    })

    proc.on('close', async (code) => {
      const status = await detectInstalledAgents()
      // Exit 0 = dialog launched. Exit 1 + "already installed" stderr = already there.
      if (code === 0) {
        onProgress({ stage: 'complete', output: 'Install dialog launched. Once you finish installing in the macOS dialog, click "Refresh" here to detect git.\n', percent: 100 })
        resolve({ success: true, error: null, newStatus: status })
      } else if (stderr.includes('already installed')) {
        onProgress({ stage: 'complete', output: 'Xcode Command Line Tools already installed.\n', percent: 100 })
        resolve({ success: true, error: null, newStatus: status })
      } else {
        onProgress({ stage: 'error', output: `xcode-select exited with code ${code}: ${stderr.trim()}\n`, percent: 100 })
        resolve({ success: false, error: stderr.trim() || `Exit code ${code}`, newStatus: status })
      }
    })
  })
}

/**
 * Install Git on Linux via the system package manager (apt/dnf/pacman/zypper).
 * Uses pkexec to show a GUI sudo prompt if available, falling back to sudo.
 */
async function installGitLinux(onProgress) {
  const { promisify } = await import('util')
  const execFileAsync = promisify(execFile)

  // Detect package manager
  const pkgManagers = [
    { bin: 'apt-get', cmd: ['apt-get', 'install', '-y', 'git'] },
    { bin: 'dnf', cmd: ['dnf', 'install', '-y', 'git'] },
    { bin: 'yum', cmd: ['yum', 'install', '-y', 'git'] },
    { bin: 'pacman', cmd: ['pacman', '-S', '--noconfirm', 'git'] },
    { bin: 'zypper', cmd: ['zypper', 'install', '-y', 'git'] },
    { bin: 'apk', cmd: ['apk', 'add', 'git'] }
  ]

  let chosen = null
  for (const pm of pkgManagers) {
    try {
      await execFileAsync('which', [pm.bin], { timeout: 3000 })
      chosen = pm
      break
    } catch { /* try next */ }
  }

  if (!chosen) {
    return {
      success: false,
      error: 'No supported package manager found (apt/dnf/yum/pacman/zypper/apk). Install git manually.',
      newStatus: await detectInstalledAgents()
    }
  }

  // Prefer pkexec (GUI sudo) over sudo (terminal-only)
  let elevator
  try {
    await execFileAsync('which', ['pkexec'], { timeout: 3000 })
    elevator = 'pkexec'
  } catch {
    elevator = 'sudo'
  }

  return new Promise((resolve) => {
    onProgress({ stage: 'starting', output: `$ ${elevator} ${chosen.cmd.join(' ')}\n`, percent: 5 })
    onProgress({ stage: 'installing', output: `Detected ${chosen.bin}. ${elevator === 'pkexec' ? 'A GUI prompt will appear for your password.' : 'You may be prompted for your sudo password in the terminal.'}\n`, percent: 20 })

    const proc = spawn(elevator, chosen.cmd, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''

    proc.stdout?.on('data', (c) => onProgress({ stage: 'installing', output: c.toString(), percent: 60 }))
    proc.stderr?.on('data', (c) => {
      stderr += c.toString()
      onProgress({ stage: 'installing', output: c.toString(), percent: 60 })
    })

    proc.on('error', async (err) => {
      onProgress({ stage: 'error', output: `Error: ${err.message}\n`, percent: 100 })
      resolve({ success: false, error: err.message, newStatus: await detectInstalledAgents() })
    })

    proc.on('close', async (code) => {
      const newStatus = await detectInstalledAgents()
      if (code === 0) {
        onProgress({ stage: 'complete', output: 'Git installed successfully!\n', percent: 100 })
        resolve({ success: true, error: null, newStatus })
      } else {
        onProgress({ stage: 'error', output: `Process exited with code ${code}\n`, percent: 100 })
        resolve({ success: false, error: `Install failed (code ${code}): ${stderr.trim()}`, newStatus })
      }
    })
  })
}

/**
 * Install Git on Windows, macOS, or Linux.
 */
async function installGit(onProgress) {
  const isWin = process.platform === 'win32'
  const isMac = process.platform === 'darwin'
  const isLinux = process.platform === 'linux'

  if (isMac) {
    return installGitMac(onProgress)
  }

  if (isLinux) {
    return installGitLinux(onProgress)
  }

  if (!isWin) {
    return {
      success: false,
      error: 'Automatic Git installation is only supported on Windows, macOS, and Linux. Please install from https://git-scm.com/',
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

  const isMac = process.platform === 'darwin'
  const isLinux = process.platform === 'linux'

  // GitHub CLI — special case
  if (agentName === 'gh') {
    if (isWin) {
      return spawnInstall('winget', ['install', '--id', 'GitHub.cli', '-e', '--accept-source-agreements', '--accept-package-agreements'], agentName, onProgress)
    }
    if (isMac) {
      return installGhMac(onProgress)
    }
    if (isLinux) {
      return installGhLinux(onProgress)
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
    if (isMac) {
      return installGlabMac(onProgress)
    }
    if (isLinux) {
      return installGlabLinux(onProgress)
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
 * Install GitHub CLI on macOS by downloading the .pkg from GitHub releases.
 */
async function installGhMac(onProgress) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  onProgress({ stage: 'starting', output: 'Resolving latest gh release...\n', percent: 5 })

  const downloadDir = join(tmpdir(), '20x-installers')
  if (!existsSync(downloadDir)) mkdirSync(downloadDir, { recursive: true })
  const pkgPath = join(downloadDir, 'gh-install.pkg')

  try {
    // Resolve latest .pkg URL from GitHub releases API
    const { net } = await import('electron')
    let pkgUrl = null
    try {
      const resp = await net.fetch('https://api.github.com/repos/cli/cli/releases/latest', {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': '20x-app' }
      })
      if (resp.ok) {
        const release = await resp.json()
        const asset = release.assets?.find(a => a.name.startsWith('gh_') && a.name.endsWith(`macOS_${arch}.pkg`))
        if (asset?.browser_download_url) pkgUrl = asset.browser_download_url
      }
    } catch { /* fall through */ }

    if (!pkgUrl) {
      throw new Error('Could not resolve gh download URL. Install manually from https://cli.github.com/')
    }

    onProgress({ stage: 'installing', output: `Downloading gh from github.com...\n`, percent: 10 })
    await downloadFile(pkgUrl, pkgPath, onProgress)

    const result = await runMacPkgInstaller(pkgPath, onProgress)
    try { unlinkSync(pkgPath) } catch { /* ignore */ }

    if (result.success) {
      onProgress({ stage: 'complete', output: 'GitHub CLI installed successfully!\n', percent: 100 })
    } else {
      onProgress({ stage: 'error', output: `Installation failed: ${result.error}\n`, percent: 100 })
    }
    return { success: result.success, error: result.error, newStatus: await detectInstalledAgents() }
  } catch (err) {
    try { unlinkSync(pkgPath) } catch { /* ignore */ }
    onProgress({ stage: 'error', output: `Error: ${err.message}\n`, percent: 100 })
    return { success: false, error: err.message, newStatus: await detectInstalledAgents() }
  }
}

/**
 * Install GitLab CLI (glab) on macOS by downloading the .tar.gz and copying
 * the binary into /usr/local/bin (requires admin via osascript).
 */
async function installGlabMac(onProgress) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64'
  onProgress({ stage: 'starting', output: 'Resolving latest glab release...\n', percent: 5 })

  const downloadDir = join(tmpdir(), '20x-installers')
  if (!existsSync(downloadDir)) mkdirSync(downloadDir, { recursive: true })
  const tarPath = join(downloadDir, 'glab.tar.gz')
  const extractDir = join(downloadDir, 'glab-extracted')

  try {
    // Resolve latest tarball from GitLab releases API
    const { net } = await import('electron')
    let tarUrl = null
    try {
      const resp = await net.fetch(
        'https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases/permalink/latest',
        { signal: AbortSignal.timeout(8000) }
      )
      if (resp.ok) {
        const release = await resp.json()
        const wantSuffix = `_macOS_${arch}.tar.gz`
        const link = release.assets?.links?.find(l => l.name?.endsWith(wantSuffix) || l.url?.endsWith(wantSuffix))
        if (link?.url) tarUrl = link.url
      }
    } catch { /* fall through */ }

    if (!tarUrl) {
      throw new Error('Could not resolve glab download URL. Install manually from https://gitlab.com/gitlab-org/cli')
    }

    onProgress({ stage: 'installing', output: `Downloading glab from gitlab.com...\n`, percent: 10 })
    await downloadFile(tarUrl, tarPath, onProgress)

    // Extract tarball
    onProgress({ stage: 'installing', output: 'Extracting...\n', percent: 70 })
    if (!existsSync(extractDir)) mkdirSync(extractDir, { recursive: true })
    await new Promise((resolve, reject) => {
      const tar = spawn('tar', ['-xzf', tarPath, '-C', extractDir], { stdio: ['ignore', 'pipe', 'pipe'] })
      tar.on('error', reject)
      tar.on('close', (code) => code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`)))
    })

    // Find the glab binary inside the extracted folder (usually bin/glab)
    const { readdirSync } = await import('fs')
    const findGlab = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          const found = findGlab(full)
          if (found) return found
        } else if (entry.name === 'glab') {
          return full
        }
      }
      return null
    }
    const glabBin = findGlab(extractDir)
    if (!glabBin) throw new Error('glab binary not found in extracted archive')

    // Copy to /usr/local/bin via admin osascript
    onProgress({ stage: 'installing', output: 'Installing to /usr/local/bin (admin prompt)...\n', percent: 85 })
    const safeBin = glabBin.replace(/"/g, '\\"')
    const installScript = `do shell script "mkdir -p /usr/local/bin && cp \\"${safeBin}\\" /usr/local/bin/glab && chmod +x /usr/local/bin/glab" with administrator privileges`

    const result = await new Promise((resolve) => {
      const proc = spawn('osascript', ['-e', installScript], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      proc.stderr?.on('data', (c) => { stderr += c.toString() })
      proc.on('error', (err) => resolve({ success: false, error: err.message }))
      proc.on('close', (code) => {
        if (code === 0) resolve({ success: true, error: null })
        else resolve({
          success: false,
          error: stderr.includes('User canceled') ? 'Installation cancelled' : `Install failed: ${stderr.trim()}`
        })
      })
    })

    // Cleanup
    try { unlinkSync(tarPath) } catch { /* ignore */ }
    try { rmSync(extractDir, { recursive: true, force: true }) } catch { /* ignore */ }

    if (result.success) {
      onProgress({ stage: 'complete', output: 'GitLab CLI installed successfully!\n', percent: 100 })
    } else {
      onProgress({ stage: 'error', output: `Installation failed: ${result.error}\n`, percent: 100 })
    }
    return { success: result.success, error: result.error, newStatus: await detectInstalledAgents() }
  } catch (err) {
    try { unlinkSync(tarPath) } catch { /* ignore */ }
    try { rmSync(extractDir, { recursive: true, force: true }) } catch { /* ignore */ }
    onProgress({ stage: 'error', output: `Error: ${err.message}\n`, percent: 100 })
    return { success: false, error: err.message, newStatus: await detectInstalledAgents() }
  }
}

/**
 * Generic helper: download a binary tarball, extract one binary by name,
 * place it in ~/.local/bin/<binName>, chmod +x. No sudo required.
 */
async function installLinuxBinaryFromTarball({ tarUrl, archiveName, binName, onProgress }) {
  const home = homedir()
  const binDir = join(home, '.local', 'bin')
  const downloadDir = join(tmpdir(), '20x-installers')
  if (!existsSync(downloadDir)) mkdirSync(downloadDir, { recursive: true })
  const tarPath = join(downloadDir, archiveName)
  const extractDir = join(downloadDir, `${binName}-extracted`)

  try {
    onProgress({ stage: 'installing', output: `Downloading ${binName}...\n`, percent: 10 })
    await downloadFile(tarUrl, tarPath, onProgress)

    onProgress({ stage: 'installing', output: 'Extracting tarball...\n', percent: 70 })
    if (!existsSync(extractDir)) mkdirSync(extractDir, { recursive: true })
    await new Promise((resolve, reject) => {
      const tar = spawn('tar', ['-xzf', tarPath, '-C', extractDir], { stdio: ['ignore', 'pipe', 'pipe'] })
      let err = ''
      tar.stderr?.on('data', (c) => { err += c.toString() })
      tar.on('error', reject)
      tar.on('close', (code) => code === 0 ? resolve() : reject(new Error(`tar exited with ${code}: ${err.trim()}`)))
    })

    // Find the binary (recurse) — usually under bin/<binName> or directly
    const { readdirSync } = await import('fs')
    const findBin = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          const found = findBin(full)
          if (found) return found
        } else if (entry.name === binName) {
          return full
        }
      }
      return null
    }
    const binPath = findBin(extractDir)
    if (!binPath) throw new Error(`${binName} binary not found in extracted archive`)

    onProgress({ stage: 'installing', output: `Installing to ${binDir}/${binName}...\n`, percent: 90 })
    if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true })
    const dest = join(binDir, binName)
    try { unlinkSync(dest) } catch { /* ignore */ }
    copyFileSync(binPath, dest)
    chmodSync(dest, 0o755)

    try { unlinkSync(tarPath) } catch { /* ignore */ }
    try { rmSync(extractDir, { recursive: true, force: true }) } catch { /* ignore */ }

    // Inject binDir into this process's PATH so subsequent spawn() calls in
    // the same 20x session can find the new binary.
    const pathWasMissing = ensureOnPath(binDir)
    const pathHint = pathWasMissing
      ? `\nNOTE: ${binDir} is not on your shell PATH. Add to ~/.bashrc or ~/.zshrc:\n  export PATH="$HOME/.local/bin:$PATH"\n`
      : ''
    onProgress({ stage: 'complete', output: `${binName} installed successfully!${pathHint}`, percent: 100 })

    return { success: true, error: null, newStatus: await detectInstalledAgents() }
  } catch (err) {
    try { unlinkSync(tarPath) } catch { /* ignore */ }
    try { rmSync(extractDir, { recursive: true, force: true }) } catch { /* ignore */ }
    onProgress({ stage: 'error', output: `Error: ${err.message}\n`, percent: 100 })
    return { success: false, error: err.message, newStatus: await detectInstalledAgents() }
  }
}

/**
 * Install GitHub CLI on Linux: download tarball → ~/.local/bin/gh.
 */
async function installGhLinux(onProgress) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  onProgress({ stage: 'starting', output: 'Resolving latest gh release...\n', percent: 5 })

  let tarUrl = null
  let archiveName = `gh.tar.gz`
  try {
    const { net } = await import('electron')
    const resp = await net.fetch('https://api.github.com/repos/cli/cli/releases/latest', {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': '20x-app' }
    })
    if (resp.ok) {
      const release = await resp.json()
      const asset = release.assets?.find(a => a.name.startsWith('gh_') && a.name.endsWith(`linux_${arch}.tar.gz`))
      if (asset?.browser_download_url) {
        tarUrl = asset.browser_download_url
        archiveName = asset.name
      }
    }
  } catch { /* fall through */ }

  if (!tarUrl) {
    onProgress({ stage: 'error', output: 'Could not resolve gh download URL.\n', percent: 100 })
    return {
      success: false,
      error: 'Could not resolve gh download URL. Install manually from https://cli.github.com/',
      newStatus: await detectInstalledAgents()
    }
  }

  return installLinuxBinaryFromTarball({ tarUrl, archiveName, binName: 'gh', onProgress })
}

/**
 * Install GitLab CLI (glab) on Linux: download tarball → ~/.local/bin/glab.
 */
async function installGlabLinux(onProgress) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64'
  onProgress({ stage: 'starting', output: 'Resolving latest glab release...\n', percent: 5 })

  let tarUrl = null
  let archiveName = 'glab.tar.gz'
  try {
    const { net } = await import('electron')
    const resp = await net.fetch(
      'https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases/permalink/latest',
      { signal: AbortSignal.timeout(8000) }
    )
    if (resp.ok) {
      const release = await resp.json()
      const wantSuffix = `_Linux_${arch}.tar.gz`
      const link = release.assets?.links?.find(l => l.name?.endsWith(wantSuffix) || l.url?.endsWith(wantSuffix))
      if (link?.url) {
        tarUrl = link.url
        archiveName = link.name || archiveName
      }
    }
  } catch { /* fall through */ }

  if (!tarUrl) {
    onProgress({ stage: 'error', output: 'Could not resolve glab download URL.\n', percent: 100 })
    return {
      success: false,
      error: 'Could not resolve glab download URL. Install manually from https://gitlab.com/gitlab-org/cli',
      newStatus: await detectInstalledAgents()
    }
  }

  return installLinuxBinaryFromTarball({ tarUrl, archiveName, binName: 'glab', onProgress })
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
