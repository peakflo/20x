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

  const PATH_START = '__20X_PATH_START__'
  const PATH_END = '__20X_PATH_END__'

  try {
    // Get user's shell
    const shell = process.env.SHELL || '/bin/zsh'

    // Use interactive login shell (`-ilc`) because tools like NVM, pnpm, bun
    // add their paths in .zshrc (interactive config), not .zprofile (login-only).
    // Wrap the PATH value in unique markers to extract it from noisy output
    // (oh-my-zsh, powerlevel10k, etc. emit escape codes and messages).
    const output = execSync(
      `${shell} -ilc 'echo ${PATH_START}$PATH${PATH_END}'`,
      { encoding: 'utf8', timeout: 5000 }
    )

    const match = output.match(new RegExp(`${PATH_START}(.+?)${PATH_END}`))
    if (match && match[1]) {
      console.log('[fixPath] Setting PATH from shell:', shell)
      process.env.PATH = match[1]
      return
    }
  } catch (error) {
    console.error('[fixPath] Failed to read shell PATH:', error)
  }

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
