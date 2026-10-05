import { execFile } from 'child_process'
import { readlink } from 'fs/promises'

/**
 * Run a command without blocking the main process. Resolves with stdout even
 * when the command exits non-zero (pgrep exits 1 when there are no matches,
 * lsof exits 1 on partial failures) and with '' when it cannot run at all.
 */
export function runQuiet(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { encoding: 'utf-8', timeout: timeoutMs }, (_error, stdout) => {
        resolve(typeof stdout === 'string' ? stdout : '')
      })
    } catch {
      resolve('')
    }
  })
}

function parsePids(output: string): number[] {
  return output
    .split('\n')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
}

type Runner = (file: string, args: string[], timeoutMs: number) => Promise<string>

/**
 * Resolve the cwd of the active shell under a PTY wrapper process.
 * The PTY is a Python process that forks a shell child; we walk down to the
 * deepest (most recently forked) descendant and read its cwd.
 */
export async function resolveTerminalCwd(
  rootPid: number,
  run: Runner = runQuiet,
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  let targetPid = rootPid
  const children = parsePids(await run('pgrep', ['-P', String(rootPid)], 2000))
  if (children.length > 0) {
    let deepest = children[children.length - 1]
    for (let i = 0; i < 5; i++) {
      const grandchildren = parsePids(await run('pgrep', ['-P', String(deepest)], 1000))
      if (grandchildren.length === 0) break
      deepest = grandchildren[grandchildren.length - 1]
    }
    targetPid = deepest
  }

  if (platform === 'linux') {
    try {
      const link = await readlink(`/proc/${targetPid}/cwd`)
      if (link) return link
    } catch { /* fall through to lsof */ }
  }

  const output = await run('lsof', ['-p', String(targetPid), '-a', '-d', 'cwd', '-Fn'], 2000)
  const cwdLine = output.split('\n').find((l) => l.startsWith('n/'))
  return cwdLine ? cwdLine.slice(1) : null
}
