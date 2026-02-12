/**
 * Rebuilds better-sqlite3 for Electron's Node.js runtime.
 *
 * pnpm's hardlink structure prevents electron-builder install-app-deps
 * from updating the binary in-place. This script finds the actual package
 * location in .pnpm and runs node-gyp rebuild with Electron headers.
 */

import { execSync } from 'child_process'
import { createRequire } from 'module'
import { dirname, join } from 'path'

const require = createRequire(import.meta.url)

const electronVersion = require('electron/package.json').version
const sqlitePath = dirname(require.resolve('better-sqlite3/package.json'))

console.log(`Rebuilding better-sqlite3 for Electron ${electronVersion}`)
console.log(`Package path: ${sqlitePath}`)

execSync(
  `npx node-gyp rebuild --runtime=electron --target=${electronVersion} --dist-url=https://electronjs.org/headers`,
  { cwd: sqlitePath, stdio: 'inherit' }
)

console.log('Done')
