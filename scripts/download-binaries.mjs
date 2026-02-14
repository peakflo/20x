#!/usr/bin/env node
import { mkdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const BIN_DIR = join(__dirname, '..', 'bin')

// Binary download URLs
const BINARIES = {
  'opencode-darwin-arm64': 'https://github.com/anomalyco/opencode/releases/latest/download/opencode-darwin-arm64',
  'opencode-darwin-x64': 'https://github.com/anomalyco/opencode/releases/latest/download/opencode-darwin-x64',
  'opencode-linux-x64': 'https://github.com/anomalyco/opencode/releases/latest/download/opencode-linux-x64',
  'opencode-win32-x64.exe': 'https://github.com/anomalyco/opencode/releases/latest/download/opencode-windows-x64.exe',
  'gh-darwin-arm64': 'https://github.com/cli/cli/releases/latest/download/gh_*_macOS_arm64.tar.gz',
  'gh-darwin-x64': 'https://github.com/cli/cli/releases/latest/download/gh_*_macOS_amd64.tar.gz',
  'gh-linux-x64': 'https://github.com/cli/cli/releases/latest/download/gh_*_linux_amd64.tar.gz',
  'gh-win32-x64.exe': 'https://github.com/cli/cli/releases/latest/download/gh_*_windows_amd64.zip'
}

async function downloadBinary(name, url) {
  console.log(`Downloading ${name}...`)
  try {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    const destPath = join(BIN_DIR, name)
    await writeFile(destPath, buffer, { mode: 0o755 })
    console.log(`✓ Downloaded ${name}`)
  } catch (error) {
    console.error(`✗ Failed to download ${name}:`, error.message)
  }
}

async function main() {
  if (!existsSync(BIN_DIR)) {
    await mkdir(BIN_DIR, { recursive: true })
  }

  console.log('Downloading binaries...\n')

  // Download only platform-specific binaries for faster builds
  const platform = process.platform
  const arch = process.arch

  const platformKey = platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'win32' : 'linux'
  const archKey = arch === 'arm64' ? 'arm64' : 'x64'

  const toDownload = Object.entries(BINARIES).filter(([name]) => {
    return name.includes(`${platformKey}-${archKey}`)
  })

  await Promise.all(toDownload.map(([name, url]) => downloadBinary(name, url)))

  console.log('\n✓ Binary download complete')
}

main().catch(console.error)
