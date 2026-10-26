/**
 * Working-directory tracking for Windows terminals.
 *
 * POSIX reads another process's cwd with /proc or lsof. Windows offers no
 * equivalent that works without native code, and spawning a helper on every
 * poll is slow. Instead the shell reports its own directory: a prompt hook
 * emits the OSC 9;9 sequence (the one Windows Terminal uses) before each
 * prompt, and the terminal output stream is scanned for it. This costs nothing
 * between prompts and needs no polling.
 */
import { basename } from 'path'

const OSC_CWD = /\x1b\]9;9;("?)([^\x07\x1b]*?)\1(?:\x07|\x1b\\)/g
const OSC_START = '\x1b]9;9;'
const OSC_END = /(?:\x07|\x1b\\)/
/** An unfinished sequence is carried to the next chunk, but never beyond this. */
const MAX_PENDING_CHARS = 2048

/** PowerShell wraps the user's own prompt so their customisation still shows. */
const POWERSHELL_HOOK =
  '$global:__20xPrompt = $function:prompt; ' +
  'function global:prompt { ' +
  '$e = [char]27; $b = [char]7; ' +
  "if ($PWD.Provider.Name -eq 'FileSystem') { [Console]::Write(\"$e]9;9;$($PWD.ProviderPath)$b\") }; " +
  '& $global:__20xPrompt }; ' +
  'Clear-Host'

/** Extra arguments that make a Windows shell report its directory, or [] for an unknown shell. */
export function shellIntegrationArgs(shellPath: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return []
  const name = basename(shellPath.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '')
  if (name === 'powershell' || name === 'pwsh') return ['-NoLogo', '-NoExit', '-Command', POWERSHELL_HOOK]
  if (name === 'cmd') return ['/K', 'prompt $E]9;9;$P$E\\$P$G']
  return []
}

export interface CwdTracker {
  /** Feed raw terminal output. */
  push(chunk: string): void
  /** The last directory the shell reported, or null before the first prompt. */
  current(): string | null
}

export function createCwdTracker(): CwdTracker {
  let pending = ''
  let cwd: string | null = null
  return {
    push(chunk: string): void {
      const text = pending + chunk
      pending = ''
      let match: RegExpExecArray | null
      OSC_CWD.lastIndex = 0
      while ((match = OSC_CWD.exec(text)) !== null) {
        const value = match[2].trim()
        if (value) cwd = value
      }
      const start = text.lastIndexOf(OSC_START)
      if (start !== -1) {
        const tail = text.slice(start)
        const finished = OSC_END.test(tail.slice(OSC_START.length))
        if (!finished && tail.length <= MAX_PENDING_CHARS) pending = tail
      } else {
        // A chunk can end in the middle of the introducer itself.
        for (let keep = OSC_START.length - 1; keep > 0; keep--) {
          if (text.endsWith(OSC_START.slice(0, keep))) {
            pending = OSC_START.slice(0, keep)
            break
          }
        }
      }
    },
    current: () => cwd
  }
}
