/**
 * Rebuilds native Node.js addons (better-sqlite3, node-pty) for Electron's
 * Node.js runtime.
 *
 * pnpm's hardlink structure prevents electron-builder install-app-deps
 * from updating the binary in-place. This script finds the actual package
 * location in .pnpm and runs node-gyp rebuild with Electron headers.
 */

import { execSync } from 'child_process'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { existsSync, readFileSync } from 'fs'

const require = createRequire(import.meta.url)

// Electron >= 42 no longer downloads its binary via a postinstall script; it
// self-installs lazily the first time the `electron` binary runs (and only then
// writes path.txt). electron-vite, by contrast, reads electron's path.txt
// straight off disk and throws "Electron uninstall" when the binary is missing
// — so `pnpm install`/CI must materialize the binary here or the dev server and
// the test runner fail before anything runs.
const electronRoot = dirname(require.resolve('electron/package.json'))
const electronPathFile = join(electronRoot, 'path.txt')
const electronBinary = existsSync(electronPathFile) ? readFileSync(electronPathFile, 'utf-8').trim() : null
const electronBinaryPath = electronBinary ? join(electronRoot, 'dist', electronBinary) : null

if (!electronBinaryPath || !existsSync(electronBinaryPath)) {
  console.log('Electron binary missing — downloading...')
  execSync(process.execPath + ' ' + JSON.stringify(join(electronRoot, 'install.js')), { stdio: 'inherit' })
  console.log('Electron binary installed')
} else {
  console.log(`Electron binary present (${electronBinary})`)
}

const electronVersion = require('electron/package.json').version

// Apple clang on recent macOS/CLT often fails to find libc++ headers
// (`climits` not found) unless the SDK sysroot is explicit.
function macSdkEnv() {
  if (process.platform !== 'darwin') return process.env
  try {
    const sdkRoot = execSync('xcrun --sdk macosx --show-sdk-path', { encoding: 'utf8' }).trim()
    if (!sdkRoot) return process.env
    const cxxInc = `${sdkRoot}/usr/include/c++/v1`
    return {
      ...process.env,
      SDKROOT: process.env.SDKROOT || sdkRoot,
      CFLAGS: `${process.env.CFLAGS || ''} -isysroot ${sdkRoot}`.trim(),
      CXXFLAGS: `${process.env.CXXFLAGS || ''} -isysroot ${sdkRoot} -I${cxxInc}`.trim(),
      CPPFLAGS: `${process.env.CPPFLAGS || ''} -isysroot ${sdkRoot} -I${cxxInc}`.trim(),
      LDFLAGS: `${process.env.LDFLAGS || ''} -isysroot ${sdkRoot}`.trim()
    }
  } catch {
    return process.env
  }
}

const rebuildEnv = macSdkEnv()

function rebuildForElectron(cwd) {
  execSync(
    `npx node-gyp rebuild --runtime=electron --target=${electronVersion} --dist-url=https://electronjs.org/headers`,
    { cwd, stdio: 'inherit', env: rebuildEnv }
  )
}

// ── better-sqlite3 ─────────────────────────────────────────────
const sqlitePath = dirname(require.resolve('better-sqlite3/package.json'))

console.log(`Rebuilding better-sqlite3 for Electron ${electronVersion}`)
console.log(`Package path: ${sqlitePath}`)

rebuildForElectron(sqlitePath)

console.log('better-sqlite3 done')

// ── node-pty ────────────────────────────────────────────────────
try {
  const ptyPath = dirname(require.resolve('node-pty/package.json'))

  console.log(`\nRebuilding node-pty for Electron ${electronVersion}`)
  console.log(`Package path: ${ptyPath}`)

  rebuildForElectron(ptyPath)

  console.log('node-pty done')
} catch (err) {
  console.warn('node-pty rebuild failed (terminal feature will be unavailable):', err.message)
}

console.log('\nAll native modules rebuilt')
