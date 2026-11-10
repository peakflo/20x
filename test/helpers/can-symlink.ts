import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Windows only lets a process create file symlinks with Developer Mode or an
 * elevated token; without it symlinkSync throws EPERM. Tests that need a real
 * symlink skip there instead of failing on the environment.
 */
export const canSymlink: boolean = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'symlink-probe-'))
  try {
    writeFileSync(join(dir, 'target'), '')
    symlinkSync(join(dir, 'target'), join(dir, 'link'), 'file')
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

export const isWindows = process.platform === 'win32'
