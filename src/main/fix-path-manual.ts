import { execSync } from 'child_process'

/**
 * Fixes PATH for macOS GUI apps by reading from user's shell
 * Alternative to fix-path package
 */
export function fixPathManual(): void {
  // Skip if not macOS or if PATH already looks good
  if (process.platform !== 'darwin') return
  if (process.env.PATH?.includes('/usr/local/bin') && process.env.PATH?.includes('homebrew')) {
    console.log('[fixPath] PATH already looks good')
    return
  }

  try {
    // Get user's shell
    const shell = process.env.SHELL || '/bin/zsh'

    // Execute shell and read PATH
    // Using login shell to get full environment
    const shellPath = execSync(`${shell} -ilc 'echo $PATH'`, {
      encoding: 'utf8',
      timeout: 5000
    }).trim()

    if (shellPath && shellPath.length > 0) {
      console.log('[fixPath] Setting PATH from shell:', shell)
      process.env.PATH = shellPath
    }
  } catch (error) {
    console.error('[fixPath] Failed to read shell PATH:', error)
    // Fallback: add common paths
    const commonPaths = [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin'
    ]
    const existingPath = process.env.PATH || ''
    const newPath = [...new Set([...commonPaths, ...existingPath.split(':')])]
      .filter(Boolean)
      .join(':')

    console.log('[fixPath] Using fallback PATH')
    process.env.PATH = newPath
  }
}
