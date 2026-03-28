/**
 * Removes broken symlinks from node_modules/.pnpm/node_modules.
 *
 * pnpm can leave dangling symlinks when dependencies are removed between
 * installs. @electron/rebuild (used by electron-builder) traverses
 * node_modules and calls stat() on every entry — a broken symlink causes
 * an ENOENT crash that blocks the entire build.
 *
 * Run this before electron-builder to ensure a clean build.
 */

import { readdirSync, lstatSync, existsSync, unlinkSync, readlinkSync } from 'fs'
import { join, resolve } from 'path'

const root = resolve(import.meta.dirname, '..')
const pnpmModules = join(root, 'node_modules', '.pnpm', 'node_modules')

let removed = 0

function cleanDir(dir, depth = 0) {
  if (depth > 3) return
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    let stat
    try {
      stat = lstatSync(full)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) {
      const target = resolve(dir, readlinkSync(full))
      if (!existsSync(target)) {
        unlinkSync(full)
        removed++
        console.log(`  removed broken symlink: ${full}`)
      }
    } else if (stat.isDirectory()) {
      cleanDir(full, depth + 1)
    }
  }
}

if (existsSync(pnpmModules)) {
  console.log('Cleaning broken symlinks in node_modules/.pnpm/node_modules ...')
  cleanDir(pnpmModules)
  if (removed === 0) {
    console.log('  no broken symlinks found')
  } else {
    console.log(`  removed ${removed} broken symlink(s)`)
  }
} else {
  console.log('No .pnpm/node_modules directory found, skipping cleanup')
}
