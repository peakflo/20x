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
import { dirname } from 'path'

const require = createRequire(import.meta.url)

const electronVersion = require('electron/package.json').version

// ── better-sqlite3 ─────────────────────────────────────────────
const sqlitePath = dirname(require.resolve('better-sqlite3/package.json'))

console.log(`Rebuilding better-sqlite3 for Electron ${electronVersion}`)
console.log(`Package path: ${sqlitePath}`)

execSync(
  `npx node-gyp rebuild --runtime=electron --target=${electronVersion} --dist-url=https://electronjs.org/headers`,
  { cwd: sqlitePath, stdio: 'inherit' }
)

console.log('better-sqlite3 done')

// ── node-pty ────────────────────────────────────────────────────
try {
  const ptyPath = dirname(require.resolve('node-pty/package.json'))

  console.log(`\nRebuilding node-pty for Electron ${electronVersion}`)
  console.log(`Package path: ${ptyPath}`)

  execSync(
    `npx node-gyp rebuild --runtime=electron --target=${electronVersion} --dist-url=https://electronjs.org/headers`,
    { cwd: ptyPath, stdio: 'inherit' }
  )

  console.log('node-pty done')
} catch (err) {
  console.warn('node-pty rebuild failed (terminal feature will be unavailable):', err.message)
}

console.log('\nAll native modules rebuilt')
