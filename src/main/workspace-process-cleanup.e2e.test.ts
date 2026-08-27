/**
 * The exit tests, run against REAL processes and the REAL process table.
 *
 * Nothing here is mocked. Watchers are spawned for real, orphaned for real by
 * killing their parent, and the sweep reads the machine's own `ps` and cwd
 * table to decide. The point is the one the unit tests cannot make: that the
 * selection still holds when the input is the operating system rather than a
 * fixture.
 *
 * Hermetic: every process it spawns lives under a temporary workspaces root of
 * its own, and it can only ever select processes rooted there.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  collectAncestorPids,
  readProcessSnapshot,
  selectLeakedWorkspacePids,
  selectPidsRootedInWorkspaces,
  sweepLeakedWorkspaceProcesses,
  terminateProcessesInWorkspaces,
  canReadProcessCwd,
  type WorkspaceState
} from './workspace-process-cleanup'

/** A watcher of the shape that leaks: it holds file descriptors and never exits. */
const WATCHER = `
const fs = require('fs')
const path = process.argv[2]
const held = []
for (let i = 0; i < 200; i++) {
  const file = path + '/watched-' + i + '.txt'
  fs.writeFileSync(file, 'x')
  held.push(fs.openSync(file, 'r'))
}
process.stdout.write('ready\\n')
setInterval(() => {}, 1000)
`

/**
 * Stands in for the `pnpm`/`turbo` layer that dies with 20x. It starts the
 * watcher and then does nothing, so SIGKILLing it reparents the watcher to
 * launchd — the exact shape a force-quit leaves behind.
 */
const LAUNCHER = `
const { spawn } = require('child_process')
const child = spawn(process.execPath, [process.argv[2], process.argv[3]], {
  cwd: process.argv[3], stdio: ['ignore', 'inherit', 'ignore'], detached: true
})
child.unref()
process.stdout.write('launched ' + child.pid + '\\n')
setInterval(() => {}, 1000)
`

const spawned: ChildProcess[] = []
const tempRoots: string[] = []

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Spawns the watcher in `cwd` and waits until it has really opened its files. */
async function startWatcher(cwd: string, scriptPath: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [scriptPath, cwd], { cwd, stdio: ['ignore', 'pipe', 'ignore'], detached: true })
  spawned.push(child)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('watcher did not report ready')), 15000)
    child.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('ready')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.on('error', reject)
  })
  return child
}

async function settle(ms = 400): Promise<void> {
  await new Promise((done) => setTimeout(done, ms))
}

/**
 * Starts a watcher in `cwd` through a launcher that is then SIGKILLed, so the
 * watcher survives with no parent — the force-quit shape, and a process this
 * test process does NOT own.
 */
async function startOrphanedWatcher(root: string, script: string, cwd: string): Promise<number> {
  const launcherPath = join(root, `launcher-${cwd.length}-${spawned.length}.cjs`)
  writeFileSync(launcherPath, LAUNCHER)
  const launcher = spawn(process.execPath, [launcherPath, script, cwd], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
  spawned.push(launcher)

  const watcherPid = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('launcher never reported')), 20000)
    let buffer = ''
    launcher.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const match = /launched (\d+)/.exec(buffer)
      if (match && buffer.includes('ready')) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    })
    launcher.on('error', reject)
  })

  process.kill(launcher.pid!, 'SIGKILL')
  await settle(1500)
  return watcherPid
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      if (child.pid) process.kill(child.pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!canReadProcessCwd())('workspace process cleanup, end to end', () => {
  function fixture(): { root: string; workspaces: string; script: string; workspaceDir: (id: string) => string } {
    const root = mkdtempSync(join(tmpdir(), '20x-sweep-'))
    tempRoots.push(root)
    const workspaces = join(root, 'workspaces')
    mkdirSync(workspaces, { recursive: true })
    const script = join(root, 'watcher.cjs')
    writeFileSync(script, WATCHER)
    return {
      root,
      workspaces,
      script,
      workspaceDir: (id: string) => {
        const dir = join(workspaces, id, 'repo', 'packages', 'workflow-api')
        mkdirSync(dir, { recursive: true })
        return dir
      }
    }
  }

  it('EXIT TEST 1+2 — kills the orphan in a finished workspace, leaves the user\'s own watcher running', async () => {
    const fx = fixture()

    // The leaked one: a watcher inside a task workspace, orphaned the way a
    // SIGKILLed 20x orphans it — its parent dies and launchd adopts it.
    const inside = await startWatcher(fx.workspaceDir('task_finished'), fx.script)
    inside.unref()

    // The user's own work: same executable, same script, OUTSIDE the root.
    const outsideDir = join(fx.root, 'user-checkout', 'packages', 'workflow-api')
    mkdirSync(outsideDir, { recursive: true })
    const outside = await startWatcher(outsideDir, fx.script)
    outside.unref()

    const insidePid = inside.pid!
    const outsidePid = outside.pid!
    expect(alive(insidePid)).toBe(true)
    expect(alive(outsidePid)).toBe(true)

    const states: Record<string, WorkspaceState> = { task_finished: { status: 'completed', exists: true } }
    const swept = await sweepLeakedWorkspaceProcesses({
      workspacesRoot: fx.workspaces,
      workspaceState: (id) => states[id] ?? { exists: false }
    })

    expect(swept.map((leak) => leak.pid)).toContain(insidePid)
    expect(swept.map((leak) => leak.pid)).not.toContain(outsidePid)
    await settle()
    expect(alive(insidePid), 'the leaked watcher must be gone').toBe(false)
    expect(alive(outsidePid), "the user's own watcher must be untouched").toBe(true)
  }, 60000)

  it('EXIT TEST 1 — a watcher orphaned by a SIGKILLed parent is gone after the boot sweep', async () => {
    // The exact reported mechanism: the top of the tree dies, the GRANDCHILD
    // survives and launchd adopts it. A shutdown hook never runs in this case,
    // so only a boot sweep can ever collect it.
    const fx = fixture()
    // Force-quit the parent, the way SIGKILL on 20x kills `pnpm` and `turbo`.
    const watcherPid = await startOrphanedWatcher(fx.root, fx.script, fx.workspaceDir('task_force_quit'))

    // BEFORE: the watcher is alive and has lost its parent.
    expect(alive(watcherPid), 'the watcher survives its parent').toBe(true)
    const before = readProcessSnapshot()
    const orphan = before.rows.find((row) => row.pid === watcherPid)
    expect(orphan, 'the watcher is still in the process table').toBeDefined()
    // Its launcher is dead, so its parent must now be either init or a
    // subreaper — and a subreaper is by definition one of OUR ancestors. Any
    // third answer would mean it is still owned by a live process, and the
    // whole premise of the test would be wrong.
    const reparentedToInit = orphan!.ppid === 1
    const adopters = collectAncestorPids(before.rows, process.pid)
    expect(reparentedToInit || adopters.has(orphan!.ppid) || orphan!.ppid === process.pid, `unexpected new parent ${orphan!.ppid}`).toBe(true)

    // macOS and an ordinary Linux session reparent to pid 1, which is the case
    // the sweep is built for. A Linux host with a subreaper in the session
    // hands the child to that instead, and it is then caught by the descendant
    // branch. Both are asserted; which one applies is the host's business.
    console.log(`watcher ${watcherPid} reparented to ppid ${orphan!.ppid}`)

    // The boot sweep, as `app.whenReady` runs it.
    const swept = await sweepLeakedWorkspaceProcesses({
      workspacesRoot: fx.workspaces,
      workspaceState: (id) => (id === 'task_force_quit' ? { status: 'completed', exists: true } : { exists: false })
    })

    // AFTER: selected as an orphan, and gone.
    const leak = swept.find((entry) => entry.pid === watcherPid)
    expect(leak, 'selected by the sweep').toBeDefined()
    expect(leak!.reason).toContain(reparentedToInit ? 'orphaned (ppid 1)' : 'our descendant')
    await settle()
    expect(alive(watcherPid), 'the watcher is gone after the boot sweep').toBe(false)
    expect(readProcessSnapshot().rows.some((row) => row.pid === watcherPid)).toBe(false)
  }, 90000)

  it('EXIT TEST 2 (again, at the selection) — an identical command line outside the root is never selected', async () => {
    const fx = fixture()
    const outsideDir = join(fx.root, 'user-checkout')
    mkdirSync(outsideDir, { recursive: true })
    const outside = await startWatcher(outsideDir, fx.script)
    outside.unref()

    const { rows, cwdRows } = readProcessSnapshot()
    const selected = selectLeakedWorkspacePids({
      rows,
      cwdRows,
      workspacesRoot: fx.workspaces,
      ownPid: process.pid,
      // Deliberately the most permissive answer possible: every workspace is
      // declared leaked. Even then the cwd keeps this process out.
      workspaceState: () => ({ status: 'completed', exists: true })
    })
    expect(selected).not.toContain(outside.pid)
    expect(alive(outside.pid!)).toBe(true)
  }, 60000)

  it('EXIT TEST 3 — removing a workspace takes the process rooted in it', async () => {
    const fx = fixture()
    // Orphaned first, deliberately. This path protects our OWN descendants —
    // a dev build of 20x lives inside a workspace and every child of it
    // inherits that cwd, so killing our own tree here would take the running
    // app's live agent sessions with it. What this path is for is a process
    // nobody owns, left in a directory that is about to be deleted.
    const pid = await startOrphanedWatcher(fx.root, fx.script, fx.workspaceDir('task_to_remove'))
    expect(alive(pid)).toBe(true)

    const killed = await terminateProcessesInWorkspaces({
      workspacesRoot: fx.workspaces,
      workspaceIds: ['task_to_remove']
    })
    expect(killed).toContain(pid)
    await settle()
    expect(alive(pid)).toBe(false)

    // Only now is the directory safe to remove.
    rmSync(join(fx.workspaces, 'task_to_remove'), { recursive: true, force: true })
  }, 60000)

  it('leaves a watcher alone while its task is still being worked on', async () => {
    const fx = fixture()
    const child = await startWatcher(fx.workspaceDir('task_live'), fx.script)
    child.unref()
    const pid = child.pid!

    const swept = await sweepLeakedWorkspaceProcesses({
      workspacesRoot: fx.workspaces,
      workspaceState: () => ({ status: 'agent_working', exists: true })
    })
    expect(swept.map((leak) => leak.pid)).not.toContain(pid)
    await settle()
    expect(alive(pid)).toBe(true)
  }, 60000)

  it('never selects this process, though its own cwd is inside the root it is given', async () => {
    // The dev build of 20x is normally checked out into a task workspace.
    const { rows, cwdRows } = readProcessSnapshot()
    const parentOfCwd = join(process.cwd(), '..')
    for (const selected of [
      selectLeakedWorkspacePids({ rows, cwdRows, workspacesRoot: parentOfCwd, ownPid: process.pid, workspaceState: () => ({ status: 'completed', exists: true }) }),
      selectPidsRootedInWorkspaces({ rows, cwdRows, workspacesRoot: parentOfCwd, ownPid: process.pid, workspaceIds: [process.cwd().split(/[\\/]/).pop()!] })
    ]) {
      expect(selected).not.toContain(process.pid)
      expect(selected).not.toContain(process.ppid)
    }
  }, 60000)
})
