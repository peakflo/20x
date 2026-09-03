/**
 * The leak test, run against a REAL `codex app-server` and the REAL process
 * table.
 *
 * The unit tests pin the teardown logic against a fake child. This one makes
 * the claim the reported bug was actually about: after a session has been
 * started, resumed twice and destroyed, THIS PROCESS HAS NO `codex app-server`
 * DESCENDANT LEFT. Nothing here is mocked — the binary is spawned for real and
 * the answer is read from `ps`.
 *
 * Hermetic in the way that matters: the selection is scoped to descendants of
 * the test process, so it can neither see nor report on the app-servers of a
 * 20x running on the same machine.
 *
 * Skipped when `codex` is not installed, which is the normal state in CI.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CodexAppServerAdapter } from './codex-app-server-adapter'
import { collectDescendantPids, parseProcessTable } from '../mcp-process-cleanup'
import { CODEX_APP_SERVER_MARKER } from '../codex-app-server-sweep'
import type { SessionConfig } from './coding-agent-adapter'

function codexAvailable(): boolean {
  if (process.platform === 'win32') return false
  try {
    execFileSync('which', ['codex'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * Every `codex app-server` process below this one, at any depth.
 *
 * Deliberately wider than what the sweep is willing to KILL: a wrapper whose
 * vendored binary outlived it would be a leak this test must still see.
 */
function appServerDescendants(): number[] {
  const ps = execFileSync('ps', ['-eo', 'pid=,ppid=,command='], { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 })
  const rows = parseProcessTable(ps)
  const ours = collectDescendantPids(rows, process.pid)
  return rows
    .filter((row) => ours.has(row.pid) && row.command.includes(CODEX_APP_SERVER_MARKER))
    .map((row) => row.pid)
    .sort((a, b) => a - b)
}

/** Waits for the app-server descendants to reach `expected`, or gives up. */
async function waitForAppServers(expected: number, timeoutMs = 10_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  let found = appServerDescendants()
  while (found.length !== expected && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 200))
    found = appServerDescendants()
  }
  return found
}

const workspaces: string[] = []

afterAll(() => {
  // Nothing should be left, but a failing assertion must not leak a gigabyte.
  for (const pid of appServerDescendants()) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!codexAvailable())('codex app-server, against the real binary', () => {
  it('leaves no app-server running once its session is over', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'codex-lifecycle-'))
    workspaces.push(workspaceDir)

    const adapter = new CodexAppServerAdapter()
    const config = {
      agentId: 'agent-e2e',
      taskId: 'task-e2e',
      workspaceDir,
      permissionMode: 'ask',
      sandboxMode: 'read-only'
    } as unknown as SessionConfig

    let sessionId: string | null = null
    try {
      sessionId = await adapter.createSession(config)
    } catch {
      // A machine with no Codex credentials fails at `thread/start`. That is
      // not a skip — it is the OTHER leak, the one where a rejected startup RPC
      // used to leave the child it had already spawned running. The assertion
      // below is the same either way, which is the point.
    }

    if (sessionId) {
      // The overwrite leak: resuming a live thread spawns another app-server
      // under the same key. Only the newest may survive each call.
      await adapter.resumeSession(sessionId, config).catch(() => undefined)
      await adapter.resumeSession(sessionId, config).catch(() => undefined)

      // One session, one app-server — as a wrapper plus its vendored binary.
      // Before the fix this was three pairs by now.
      const live = await waitForAppServers(2)
      expect(live.length).toBeLessThanOrEqual(2)

      await adapter.destroySession(sessionId, config)
    }

    expect(await waitForAppServers(0)).toEqual([])
  }, 180_000)
})
