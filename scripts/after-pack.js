/**
 * electron-builder afterPack hook
 *
 * Strips non-target-platform binaries from the packaged app to reduce size and
 * avoid codesigning foreign executables during macOS release builds.
 */

const { join } = require('path')
const { rm, readdir, stat } = require('fs/promises')

/**
 * Map electron-builder arch+platform to the ripgrep/audio-capture directory
 * names used by claude-agent-sdk.
 */
function getRipgrepPlatformDir(electronPlatform, electronArch) {
  return `${electronArch}-${electronPlatform}`
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath)
    return true
  } catch {
    return false
  }
}

async function getExistingAppRoots(context) {
  const productFilename = context.packager?.appInfo?.productFilename || 'app'
  const candidateRoots = [
    join(context.appOutDir, 'resources', 'app'),
    join(context.appOutDir, 'resources', 'app.asar.unpacked'),
    join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources', 'app'),
    join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources', 'app.asar.unpacked')
  ]

  const existingRoots = []
  for (const root of candidateRoots) {
    if (await pathExists(root)) {
      existingRoots.push(root)
    }
  }

  return existingRoots
}

async function prunePlatformSubdirs(parentDir, keepDir) {
  const entries = await readdir(parentDir)
  for (const entry of entries) {
    if (entry === keepDir || entry === 'COPYING') continue
    const entryPath = join(parentDir, entry)
    const entryStat = await stat(entryPath)
    if (!entryStat.isDirectory()) continue

    console.log(`[after-pack] Removing ${entryPath} (not target platform)`)
    await rm(entryPath, { recursive: true, force: true })
  }
}

async function cleanupSdkPath(sdkPath, keepDir) {
  for (const vendorDir of ['ripgrep', 'audio-capture']) {
    const vendorPath = join(sdkPath, 'vendor', vendorDir)
    try {
      await prunePlatformSubdirs(vendorPath, keepDir)
    } catch (err) {
      console.log(`[after-pack] No ${vendorDir} vendor dir at ${vendorPath}: ${err.message}`)
    }
  }

  try {
    const cliPath = join(sdkPath, 'cli.js')
    await stat(cliPath)
    console.log('[after-pack] Removing cli.js (11MB, not needed at runtime)')
    await rm(cliPath, { force: true })
  } catch {
    // cli.js not found, ok
  }

  for (const wasmFile of ['resvg.wasm', 'tree-sitter.wasm', 'tree-sitter-bash.wasm']) {
    try {
      const wasmPath = join(sdkPath, wasmFile)
      await stat(wasmPath)
      console.log(`[after-pack] Removing ${wasmFile}`)
      await rm(wasmPath, { force: true })
    } catch {
      // File not found, ok
    }
  }

  console.log(`[after-pack] Cleaned up ${sdkPath}`)
}

async function afterPack(context) {
  const appRoots = await getExistingAppRoots(context)

  if (appRoots.length === 0) {
    console.log('[after-pack] No packaged app roots found, skipping binary cleanup')
    return
  }

  const platform = context.electronPlatformName
  const arch = context.arch === 1 ? 'x64' : context.arch === 3 ? 'arm64' : 'x64'
  const keepDir = getRipgrepPlatformDir(platform, arch)

  console.log(`[after-pack] Target platform: ${keepDir}`)
  console.log(`[after-pack] App roots: ${appRoots.join(', ')}`)

  for (const baseDir of appRoots) {
    const possiblePaths = [
      join(baseDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'),
      join(baseDir, 'node_modules', '.pnpm', 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
    ]

    for (const sdkPath of possiblePaths) {
      if (!(await pathExists(sdkPath))) continue
      await cleanupSdkPath(sdkPath, keepDir)
    }
  }

  console.log('[after-pack] Binary cleanup complete')
}

module.exports = afterPack
module.exports.getExistingAppRoots = getExistingAppRoots
module.exports.getRipgrepPlatformDir = getRipgrepPlatformDir
