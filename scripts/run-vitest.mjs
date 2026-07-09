/**
 * Cross-platform Vitest launcher for Electron-as-Node.
 *
 * package.json cannot use `ELECTRON_RUN_AS_NODE=1 electron ...` on Windows
 * (cmd/PowerShell do not support Unix env-var prefix syntax). This script
 * sets the env var in-process and spawns Electron with Vitest.
 */

import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

const electronPath = require('electron')
const vitestEntry = join(projectRoot, 'node_modules', 'vitest', 'vitest.mjs')
const vitestArgs = process.argv.slice(2)

const result = spawnSync(electronPath, [vitestEntry, ...vitestArgs], {
  cwd: projectRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
  shell: false
})

if (result.error) {
  console.error(result.error)
  process.exit(1)
}

process.exit(result.status ?? 1)
