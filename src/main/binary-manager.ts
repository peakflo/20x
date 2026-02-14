import { app } from 'electron'
import { join } from 'path'
import { existsSync, chmodSync } from 'fs'

export class BinaryManager {
  private binPath: string

  constructor() {
    // In development: use local bin/ directory
    // In production: use bundled resources
    this.binPath = app.isPackaged
      ? join(process.resourcesPath, 'bin')
      : join(__dirname, '../../bin')
  }

  /**
   * Get the path to the bundled opencode binary
   */
  getOpencodePath(): string | null {
    const platform = process.platform
    const arch = process.arch
    const ext = platform === 'win32' ? '.exe' : ''
    const binaryName = `opencode-${platform}-${arch}${ext}`
    const fullPath = join(this.binPath, binaryName)

    if (existsSync(fullPath)) {
      // Ensure executable on Unix
      if (platform !== 'win32') {
        try {
          chmodSync(fullPath, 0o755)
        } catch {}
      }
      return fullPath
    }

    return null
  }

  /**
   * Get the path to the bundled gh binary
   */
  getGhPath(): string | null {
    const platform = process.platform
    const arch = process.arch
    const ext = platform === 'win32' ? '.exe' : ''
    const binaryName = `gh-${platform}-${arch}${ext}`
    const fullPath = join(this.binPath, binaryName)

    if (existsSync(fullPath)) {
      // Ensure executable on Unix
      if (platform !== 'win32') {
        try {
          chmodSync(fullPath, 0o755)
        } catch {}
      }
      return fullPath
    }

    return null
  }

  /**
   * Check if bundled binaries exist
   */
  checkBinaries(): { opencode: boolean; gh: boolean } {
    return {
      opencode: this.getOpencodePath() !== null,
      gh: this.getGhPath() !== null
    }
  }
}
