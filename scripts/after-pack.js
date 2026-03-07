/**
 * electron-builder afterPack hook
 *
 * Strips non-target-platform binaries from the packaged app to reduce size.
 * This runs after electron-builder packs files but before creating the installer.
 *
 * Targets:
 * - claude-agent-sdk vendor/ripgrep: ships all 6 platforms (~61MB), we only need 1 (~10MB)
 * - claude-agent-sdk cli.js: 11MB CLI entrypoint not needed at runtime (we use sdk.mjs)
 * - claude-agent-sdk wasm files: resvg.wasm + tree-sitter*.wasm (~4MB) not needed for SDK usage
 */

const { join } = require('path')
const { rm, readdir, stat } = require('fs/promises')

/**
 * Map electron-builder arch+platform to the ripgrep directory name used by claude-agent-sdk
 */
function getRipgrepPlatformDir(electronPlatform, electronArch) {
  // claude-agent-sdk uses Node.js naming: arm64-darwin, x64-linux, etc.
  return `${electronArch}-${electronPlatform}`
}

async function afterPack(context) {
  const appDir = join(context.appOutDir, 'resources', 'app.asar.unpacked')
  const asarAppDir = join(context.appOutDir, 'resources', 'app')

  // Determine which base to work with
  let baseDir
  try {
    await stat(asarAppDir)
    baseDir = asarAppDir
  } catch {
    try {
      await stat(appDir)
      baseDir = appDir
    } catch {
      // If using asar, we need to work differently
      console.log('[after-pack] No unpacked app directory found, skipping binary cleanup')
      return
    }
  }

  const platform = context.electronPlatformName // 'darwin', 'linux', 'win32'
  const arch = context.arch === 1 ? 'x64' : context.arch === 3 ? 'arm64' : 'x64'
  const keepDir = getRipgrepPlatformDir(platform, arch)

  console.log(`[after-pack] Target platform: ${keepDir}`)
  console.log(`[after-pack] App directory: ${baseDir}`)

  // Find claude-agent-sdk in node_modules (may be in .pnpm structure or hoisted)
  const possiblePaths = [
    join(baseDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'),
    join(baseDir, 'node_modules', '.pnpm', 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
  ]

  for (const sdkPath of possiblePaths) {
    try {
      await stat(sdkPath)
    } catch {
      continue
    }

    // 1. Strip non-target ripgrep binaries
    const ripgrepDir = join(sdkPath, 'vendor', 'ripgrep')
    try {
      const entries = await readdir(ripgrepDir)
      for (const entry of entries) {
        if (entry === keepDir || entry === 'COPYING') continue
        const entryPath = join(ripgrepDir, entry)
        const entryStat = await stat(entryPath)
        if (entryStat.isDirectory()) {
          console.log(`[after-pack] Removing ripgrep/${entry} (not target platform)`)
          await rm(entryPath, { recursive: true, force: true })
        }
      }
    } catch (err) {
      console.log(`[after-pack] No ripgrep vendor dir at ${ripgrepDir}: ${err.message}`)
    }

    // 2. Remove cli.js (11MB) - only sdk.mjs is needed for runtime SDK usage
    try {
      const cliPath = join(sdkPath, 'cli.js')
      await stat(cliPath)
      console.log('[after-pack] Removing cli.js (11MB, not needed at runtime)')
      await rm(cliPath, { force: true })
    } catch {
      // cli.js not found, ok
    }

    // 3. Remove wasm files not needed for SDK usage
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

  console.log('[after-pack] Binary cleanup complete')
}

module.exports = afterPack
