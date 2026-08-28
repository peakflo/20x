/**
 * Cleanup of processes left running inside an agent task workspace.
 *
 * This is the same defect `mcp-process-cleanup.ts` already fixes for stdio MCP
 * children, one level further out. A task runs `pnpm dev` (or any long-lived
 * watcher) inside its workspace. When the session ends, the user stops it, or
 * 20x is force-quit, the top of the tree dies — `pnpm`, `turbo` — but a
 * GRANDCHILD such as `tsx watch` survives, is reparented to launchd, and keeps
 * watching several thousand files for days. Measured on the owner's machine:
 * two such processes held 20,341 file descriptors, 43% of everything open, and
 * `next dev` in another repo died with
 * `Watchpack Error (watcher): Error: EMFILE: too many open files`.
 *
 * WHAT MAKES A PROCESS LEAKED — the cwd and the task's state, NEVER the name.
 * `node`, `tsx` and `next` are also how the user runs their own work. Matching
 * on the command would kill a developer's own dev server. So the selection here
 * is:
 *
 *   1. the process's cwd is inside a TASK WORKSPACE directory, and
 *   2. that workspace belongs to a task that is not being worked on, or to no
 *      task at all, or to a directory that has already been removed, and
 *   3. the process is either a descendant of THIS 20x instance (so no other
 *      instance can be using it) or has already lost its parent (ppid 1).
 *
 * Rule 3 is copied from `selectKillableMcpPids` for the same reason: two 20x
 * instances on one machine (a packaged app and a dev build) are normal, and
 * quitting one must not kill the live children of the other.
 *
 * ONE CONSEQUENCE, STATED SO IT IS NOT A SURPRISE: some processes are `ppid 1`
 * BY DESIGN, `screen -dm` and `tmux` among them. One started inside a task
 * workspace whose task has finished is selected. That is intended and follows
 * from a policy that already exists — 20x deletes those directories on a
 * schedule, so a service living in one was going to lose its files anyway. This
 * only makes the process policy agree with the directory policy. A long-lived
 * service belongs outside the workspaces root.
 */

import { execFileSync } from 'child_process'
import { existsSync, readlinkSync, realpathSync, statfsSync } from 'fs'
import { isAbsolute, normalize, resolve, sep } from 'path'
import { collectDescendantPids, parseProcessTable, type ProcessRow } from './mcp-process-cleanup'

export type { ProcessRow }

/** One process and the directory it is running in. */
export type CwdRow = { pid: number; cwd: string }

/**
 * Task statuses in which an agent may legitimately be running a process inside
 * its workspace. Every other status — including `ready_for_review` and
 * `completed` — means nobody is driving that workspace any more.
 *
 * Kept as plain strings so this module stays free of Electron and of the
 * renderer's constants, and can be unit-tested on its own.
 */
export const ACTIVE_TASK_STATUSES: readonly string[] = ['triaging', 'agent_working', 'agent_learning']

/**
 * Parses `lsof -a -d cwd -n -P -w -F pn` output.
 *
 * The field format emits one `p<pid>` line followed by one `n<path>` line per
 * process. A `p` line with no `n` line (the process exited mid-scan) is
 * dropped rather than paired with the next process's path.
 */
export function parseLsofCwd(lsofOutput: string): CwdRow[] {
  const rows: CwdRow[] = []
  let pid: number | null = null
  for (const line of lsofOutput.split('\n')) {
    if (line.startsWith('p')) {
      const parsed = Number(line.slice(1))
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null
    } else if (line.startsWith('n')) {
      const path = line.slice(1)
      if (pid !== null && path.length > 0) rows.push({ pid, cwd: path })
      pid = null
    }
  }
  return rows
}

/**
 * The workspace directory name a cwd sits in, or null when the cwd is not
 * inside the workspaces root.
 *
 * Compared on PATH SEGMENTS, never as a string prefix. `startsWith` would make
 * `<root>-backup/repo` look like a workspace, and the root itself has no
 * workspace id — a shell sitting in `<root>` is not rooted in any task.
 */
export function workspaceIdForCwd(cwd: string, workspacesRoot: string): string | null {
  if (!cwd || !workspacesRoot || !isAbsolute(cwd) || !isAbsolute(workspacesRoot)) return null

  const root = normalize(resolve(workspacesRoot))
  const path = normalize(resolve(cwd))
  const prefix = root.endsWith(sep) ? root : root + sep
  if (!path.startsWith(prefix)) return null

  // `resolve` has already collapsed `.` and `..`, and a path equal to the root
  // failed the prefix check above, so the first segment is always a real name.
  return path.slice(prefix.length).split(sep)[0]
}

/** Every ancestor of `pid`, up to the top of the table. */
export function collectAncestorPids(rows: ProcessRow[], pid: number): Set<number> {
  const parentOf = new Map<number, number>()
  for (const row of rows) parentOf.set(row.pid, row.ppid)

  const ancestors = new Set<number>()
  let current = parentOf.get(pid)
  while (current !== undefined && current > 1 && !ancestors.has(current)) {
    ancestors.add(current)
    current = parentOf.get(current)
  }
  return ancestors
}

/** The pids that must never be signalled: this process and everything above it. */
function protectedPids(rows: ProcessRow[], ownPid: number): Set<number> {
  const guarded = collectAncestorPids(rows, ownPid)
  guarded.add(ownPid)
  guarded.add(0)
  guarded.add(1)
  return guarded
}

/**
 * Adds the descendants of each selected pid THAT ARE THEMSELVES ROOTED IN THE
 * WORKSPACES ROOT, so a whole leaked tree goes but nothing else does.
 *
 * Taking the descendants matters: the orphan measured on the machine was a
 * 49-fd `node`, but the `firefox` it had spawned held 449 more, and killing
 * only the matched process leaves 90% of the leak behind.
 *
 * Requiring the descendant's OWN cwd to be in the root matters just as much,
 * and this originally did not. A `tmux` or `screen` server started once inside
 * a workspace is `ppid 1` by design and is selected when that task finishes —
 * but its panes are its descendants, and their cwds are wherever the user put
 * them. Without this check, one finished task took down the user's editor,
 * their dev server in their own checkout, and any 20x instance launched from
 * that session, with its running agents. That is the exact catastrophe this
 * module exists to avoid, arrived at from the other direction.
 *
 * A descendant with no readable cwd is left alone: not readable is not leaked.
 */
function withDescendants(
  rows: ProcessRow[],
  roots: Iterable<number>,
  guarded: Set<number>,
  isRootedInWorkspaces: (pid: number) => boolean
): number[] {
  const selected = new Set<number>()
  for (const root of roots) {
    if (guarded.has(root)) continue
    selected.add(root)
    for (const child of collectDescendantPids(rows, root)) {
      if (guarded.has(child) || !isRootedInWorkspaces(child)) continue
      selected.add(child)
    }
  }
  return [...selected].sort((a, b) => a - b)
}

/** "Is this pid's cwd inside the workspaces root?", as a reusable predicate. */
function rootedInWorkspaces(cwdRows: readonly CwdRow[], workspacesRoot: string): (pid: number) => boolean {
  const cwdByPid = new Map(cwdRows.map((row) => [row.pid, row.cwd]))
  return (pid) => {
    const cwd = cwdByPid.get(pid)
    return cwd !== undefined && workspaceIdForCwd(cwd, workspacesRoot) !== null
  }
}

/** How the caller answers "is this workspace still in use?". */
export type WorkspaceState = {
  /** The task's status, or undefined when no task row matches the directory. */
  status?: string
  /** False when the workspace directory itself is gone. */
  exists: boolean
}

export type LeakSelection = {
  rows: ProcessRow[]
  cwdRows: CwdRow[]
  workspacesRoot: string
  ownPid: number
  /** Looks up the task behind a workspace directory name. */
  workspaceState: (workspaceId: string) => WorkspaceState
  /**
   * Whether a parentless process is leaked WHATEVER its task's status says.
   *
   * True only for the BOOT sweep, and it is what makes the reported bug
   * actually get fixed. `stopAllSessions` deliberately preserves task status
   * across a quit (`agent-manager.ts`: "Don't reset task status during app
   * shutdown"), and nothing repairs it at startup — so a task that was
   * force-quit mid-run stays `agent_working` in SQLite FOREVER. Without this,
   * the watcher it leaked is vetoed by its own stale status on every boot from
   * then on, and the headline case — "20x is force-quit" — is the one case the
   * sweep could never collect.
   *
   * Sound only at boot, and only for `ppid 1`: this instance has no descendants
   * yet, so no agent of ours can own the process; and another live instance's
   * agent children are parented to that instance, not to launchd. Our own
   * descendants are still judged on task state, so a live session is safe.
   */
  orphansIgnoreTaskState?: boolean
}

/** A leaked process, kept with its reason so the log can say why it went. */
export type LeakedProcess = { pid: number; workspaceId: string; reason: string; command: string }

/**
 * The leaked roots — matched processes only, before their descendants are
 * added. Exported so a caller can report exactly what it matched and why.
 */
export function selectLeakedWorkspaceRoots(input: LeakSelection): LeakedProcess[] {
  const { rows, cwdRows, workspacesRoot, ownPid, workspaceState } = input
  const guarded = protectedPids(rows, ownPid)
  const ourDescendants = collectDescendantPids(rows, ownPid)
  const cwdByPid = new Map(cwdRows.map((row) => [row.pid, row.cwd]))

  const leaked: LeakedProcess[] = []
  for (const row of rows) {
    if (guarded.has(row.pid)) continue

    // Scope: only what this instance owns, or what has already lost its owner.
    const ours = ourDescendants.has(row.pid)
    if (!ours && row.ppid !== 1) continue

    const cwd = cwdByPid.get(row.pid)
    if (!cwd) continue
    const workspaceId = workspaceIdForCwd(cwd, workspacesRoot)
    if (!workspaceId) continue

    const state = workspaceState(workspaceId)
    const active = state.status !== undefined && ACTIVE_TASK_STATUSES.includes(state.status)

    let reason: string | null = null
    if (active) {
      // An agent is working here. Nothing else may override that — including a
      // missing directory, which is far more likely to be a failed listing than
      // a deleted workspace. The one exception is a parentless process at boot,
      // where the status itself cannot be trusted (see `orphansIgnoreTaskState`).
      if (!ours && input.orphansIgnoreTaskState) reason = `task ${state.status} but parentless at startup`
    } else if (!state.exists) reason = 'workspace directory removed'
    else if (state.status === undefined) reason = 'no task for this workspace'
    else reason = `task ${state.status}`
    if (!reason) continue

    leaked.push({ pid: row.pid, workspaceId, reason: `${reason}, ${ours ? 'our descendant' : 'orphaned (ppid 1)'}`, command: row.command })
  }
  return leaked
}

/** Adds the descendants of already-selected roots, keeping the same guards. */
export function expandToProcessTrees(
  rows: ProcessRow[],
  cwdRows: readonly CwdRow[],
  workspacesRoot: string,
  roots: readonly number[],
  ownPid: number
): number[] {
  return withDescendants(rows, roots, protectedPids(rows, ownPid), rootedInWorkspaces(cwdRows, workspacesRoot))
}

/** Every pid to kill: the leaked roots plus their descendants. */
export function selectLeakedWorkspacePids(input: LeakSelection): number[] {
  const roots = selectLeakedWorkspaceRoots(input).map((leak) => leak.pid)
  return expandToProcessTrees(input.rows, input.cwdRows, input.workspacesRoot, roots, input.ownPid)
}

/**
 * Every process rooted in one of `workspaceIds`, whoever its parent is.
 *
 * Used when a workspace DIRECTORY is about to be deleted. There the scope rule
 * above does not apply and must not: the directory is going, so a process still
 * running in it cannot be left behind, and its parent's identity is irrelevant.
 * A process must not outlive its workspace.
 */
export function selectPidsRootedInWorkspaces(input: {
  rows: ProcessRow[]
  cwdRows: CwdRow[]
  workspacesRoot: string
  ownPid: number
  workspaceIds: readonly string[]
}): number[] {
  const wanted = new Set(input.workspaceIds)
  const guarded = protectedPids(input.rows, input.ownPid)
  // OUR OWN DESCENDANTS ARE PROTECTED HERE, and that is not a detail.
  // A dev build of 20x is normally checked out INSIDE a task workspace, so the
  // main process's cwd is that workspace and every child inherits it — the
  // shared `opencode serve`, the stdio MCP children, git. Protecting only self
  // and ancestors meant that when that task finally passed the retention
  // window, the daily cleanup killed the running app's entire subprocess tree,
  // every live agent session with it, and then deleted the directory underneath.
  // Whatever we own is the sweep's business, judged on task state; this path
  // exists for processes we do NOT own.
  for (const pid of collectDescendantPids(input.rows, input.ownPid)) guarded.add(pid)
  const known = new Set(input.rows.map((row) => row.pid))

  const roots: number[] = []
  for (const { pid, cwd } of input.cwdRows) {
    if (guarded.has(pid) || !known.has(pid)) continue
    const workspaceId = workspaceIdForCwd(cwd, input.workspacesRoot)
    if (workspaceId && wanted.has(workspaceId)) roots.push(pid)
  }
  return withDescendants(input.rows, roots, guarded, rootedInWorkspaces(input.cwdRows, input.workspacesRoot))
}

// ── Runtime ─────────────────────────────────────────────────
//
// Everything above is pure and unit-tested. Below is the thin layer that reads
// the real process table and signals. It is deliberately free of Electron so
// the module can be imported from the scheduler and from `index.ts` alike.

/**
 * lsof is not on the PATH Electron inherits on every machine, so the usual
 * install locations are tried in turn rather than assumed.
 */
const LSOF_CANDIDATES = ['/usr/sbin/lsof', '/usr/bin/lsof', 'lsof'] as const

/**
 * Both reads are bounded. The boot sweep is awaited BEFORE the window is
 * created and the shutdown sweep runs inside a `preventDefault`ed `before-quit`,
 * so a hang means an app that never appears or never exits. `lsof` in
 * particular blocks on an unresponsive network mount; `-w` suppresses its
 * warnings, it does not bound its time. A `try/catch` catches a throw, never a
 * hang. Healthy cost measured on the affected machine: 0.34 s.
 */
const SUBPROCESS_TIMEOUT_MS = 20_000

function readCwdsWithLsof(): CwdRow[] {
  // `-w` suppresses the warnings lsof prints for directories it cannot read;
  // without it an ordinary permission notice looks like a failure. `-n` and
  // `-P` skip DNS and service lookups.
  const args = ['-a', '-d', 'cwd', '-n', '-P', '-w', '-F', 'pn']
  let lastError: unknown = new Error('lsof not found')
  for (const binary of LSOF_CANDIDATES) {
    try {
      return parseLsofCwd(execFileSync(binary, args, { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024, timeout: SUBPROCESS_TIMEOUT_MS }))
    } catch (err) {
      // lsof exits non-zero when any process refused inspection, but still
      // prints everything it could read. Use that rather than losing the scan.
      const output = (err as { stdout?: string }).stdout
      if (typeof output === 'string' && output.length > 0) return parseLsofCwd(output)
      lastError = err
    }
  }
  throw lastError
}

/** On Linux the kernel answers directly, with no lsof and no subprocess. */
function readCwdsFromProc(pids: readonly number[]): CwdRow[] {
  const rows: CwdRow[] = []
  for (const pid of pids) {
    try {
      rows.push({ pid, cwd: readlinkSync(`/proc/${pid}/cwd`) })
    } catch {
      // Exited mid-scan, or owned by another user. Not readable is not leaked.
    }
  }
  return rows
}

/** Both tables, read once. A full cwd scan measures at ~0.7 s via lsof on macOS. */
export function readProcessSnapshot(): { rows: ProcessRow[]; cwdRows: CwdRow[] } {
  const ps = execFileSync('ps', ['-eo', 'pid=,ppid=,command='], {
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: SUBPROCESS_TIMEOUT_MS
  })
  const rows = parseProcessTable(ps)
  // On Linux `/proc` answers directly. But `hidepid=2`, a container, or another
  // uid can make every entry unreadable, and an EMPTY cwd table is
  // indistinguishable from "nothing is leaked" — the sweep would report success
  // having looked at nothing. Fall back to lsof, and say so if both come back
  // empty against a non-empty process table.
  let cwdRows = existsSync('/proc/self/cwd') ? readCwdsFromProc(rows.map((row) => row.pid)) : []
  if (cwdRows.length === 0) {
    try {
      cwdRows = readCwdsWithLsof()
    } catch (err) {
      console.warn('[WorkspaceProcessCleanup] Could not read any process cwd:', err)
    }
  }
  if (cwdRows.length === 0 && rows.length > 0) {
    console.warn(`[WorkspaceProcessCleanup] Read ${rows.length} processes but no cwd for any of them — the sweep can see nothing and is a no-op.`)
  }
  return { rows, cwdRows }
}

/** How long a process gets to honour SIGTERM before SIGKILL. */
export const DEFAULT_GRACE_MS = 1500

/**
 * The grace used while quitting. Shorter, because quit latency is visible to
 * the user and the BOOT sweep is the backstop: anything that ignores SIGTERM
 * here is collected on the next start, which is the path that has to work
 * anyway for a force-quit.
 */
export const SHUTDOWN_GRACE_MS = 300

/**
 * SIGTERM, a short grace period, then SIGKILL for whatever ignored it.
 * A watcher that traps SIGTERM and keeps its file descriptors is exactly the
 * process this whole module exists to remove.
 *
 * There is a pid-reuse window of roughly a second between reading the table and
 * signalling: a selected process could exit and its number be handed to
 * something else. `kill(pid, 0)` proves a process exists, never that it is the
 * same one. The exposure is identical to the MCP sweep this copies, it is not
 * closable without a pidfd (Linux) or a kqueue handle per process, and a second
 * of window against days of leaked descriptors is the right trade. Written down
 * rather than engineered around.
 */
export async function terminateProcessTree(pids: readonly number[], graceMs = DEFAULT_GRACE_MS): Promise<void> {
  if (pids.length === 0) return
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone between the listing and the signal.
    }
  }
  await new Promise((done) => setTimeout(done, graceMs))
  for (const pid of pids) {
    try {
      process.kill(pid, 0) // throws when the process is gone
      process.kill(pid, 'SIGKILL')
    } catch {
      // Gone, which is the outcome we wanted.
    }
  }
}

/**
 * The workspaces root as the KERNEL spells it.
 *
 * Both `lsof` and `/proc/<pid>/cwd` report a cwd with every symlink already
 * resolved, and the configured root need not be — on macOS `os.tmpdir()` is
 * `/var/folders/...` while the kernel says `/private/var/folders/...`, and a
 * home directory can be a symlink too. Comparing the two forms makes every
 * workspace look OUTSIDE the root, so the sweep finds nothing and reports
 * success. Found exactly that way: the end-to-end test selected zero processes
 * while its watcher was plainly running in the workspace it had been given.
 *
 * Falls back to the path as given when it does not exist yet — there is then
 * nothing under it to sweep either way.
 */
export function resolveWorkspacesRoot(workspacesRoot: string): string {
  try {
    return realpathSync(workspacesRoot)
  } catch {
    return workspacesRoot
  }
}

/** Free and total bytes on the volume holding `path`, or undefined if unreadable. */
export function readDiskSpace(path: string): DiskSpace | undefined {
  try {
    const stats = statfsSync(path)
    return { freeBytes: stats.bsize * stats.bavail, totalBytes: stats.bsize * stats.blocks }
  } catch {
    // A missing directory or an unsupported filesystem. The count still warns.
    return undefined
  }
}

/** True on platforms where a process's cwd can be read. Windows has no cheap query. */
export function canReadProcessCwd(): boolean {
  return process.platform !== 'win32'
}

/**
 * The boot and shutdown sweep. Boot is the important one: these orphans
 * reparent to launchd, so a shutdown hook alone never sees a machine that was
 * force-quit or rebooted.
 */
export async function sweepLeakedWorkspaceProcesses(input: {
  workspacesRoot: string
  workspaceState: (workspaceId: string) => WorkspaceState
  ownPid?: number
  graceMs?: number
  /** See `LeakSelection.orphansIgnoreTaskState`. Boot sweep only. */
  orphansIgnoreTaskState?: boolean
}): Promise<LeakedProcess[]> {
  if (!canReadProcessCwd()) return []
  const ownPid = input.ownPid ?? process.pid
  const { rows, cwdRows } = readProcessSnapshot()
  const workspacesRoot = resolveWorkspacesRoot(input.workspacesRoot)
  const selection: LeakSelection = {
    rows,
    cwdRows,
    workspacesRoot,
    ownPid,
    workspaceState: input.workspaceState,
    orphansIgnoreTaskState: input.orphansIgnoreTaskState
  }

  const leaked = selectLeakedWorkspaceRoots(selection)
  if (leaked.length === 0) return []

  const pids = expandToProcessTrees(rows, cwdRows, workspacesRoot, leaked.map((leak) => leak.pid), ownPid)
  for (const leak of leaked) {
    console.log(`[WorkspaceProcessCleanup] Killing pid ${leak.pid} in workspace ${leak.workspaceId} — ${leak.reason}: ${leak.command.slice(0, 160)}`)
  }
  await terminateProcessTree(pids, input.graceMs)
  console.log(`[WorkspaceProcessCleanup] Terminated ${pids.length} process(es) across ${leaked.length} leaked workspace root(s)`)
  return leaked
}

/** Kills everything rooted in the given workspaces, before their directories go. */
export async function terminateProcessesInWorkspaces(input: {
  workspacesRoot: string
  workspaceIds: readonly string[]
  ownPid?: number
}): Promise<number[]> {
  if (!canReadProcessCwd() || input.workspaceIds.length === 0) return []
  const ownPid = input.ownPid ?? process.pid
  const { rows, cwdRows } = readProcessSnapshot()
  const pids = selectPidsRootedInWorkspaces({ rows, cwdRows, workspacesRoot: resolveWorkspacesRoot(input.workspacesRoot), ownPid, workspaceIds: input.workspaceIds })
  if (pids.length === 0) return []
  console.log(`[WorkspaceProcessCleanup] ${pids.length} process(es) still rooted in ${input.workspaceIds.length} workspace(s) being removed: ${pids.join(', ')}`)
  await terminateProcessTree(pids)
  return pids
}

/**
 * Pairs the workspace directories on disk with the tasks that own them.
 *
 * A directory with no task is reported with `status: undefined` (nothing owns
 * it), and a task whose directory is gone with `exists: false` — both are
 * leaked states, and a process rooted in either has nothing left to serve.
 */
export function buildWorkspaceStates(
  tasks: readonly { id: string; status: string }[],
  workspaceDirs: readonly string[]
): Map<string, WorkspaceState> {
  const onDisk = new Set(workspaceDirs)
  const states = new Map<string, WorkspaceState>()
  for (const dir of onDisk) states.set(dir, { exists: true })
  for (const task of tasks) {
    states.set(task.id, { status: task.status, exists: onDisk.has(task.id) })
  }
  return states
}

/**
 * How many workspaces exist, so an unbounded count is visible rather than
 * merely felt. Each carries its own `node_modules`; the machine this was found
 * on had 397 of them holding 313 GB, which is a disk and inode problem in its
 * own right, independent of the process leak.
 */
export const WORKSPACE_COUNT_WARN_THRESHOLD = 100

/**
 * Warn below this share of the volume free, whatever the workspace count says.
 *
 * A count is a weak signal on its own. Measured on the affected machine over
 * one day: 397 workspaces / 313 GB, then 398 / 315 GB — roughly 2 GB per agent
 * run, against 39 GiB free on a 926 GiB volume, 96% full. "398 workspaces" does
 * not convey that; "39 GiB free, 4% of the volume" does, and it is the number
 * that decides whether the next run succeeds.
 */
export const WORKSPACE_FREE_SPACE_WARN_FRACTION = 0.1

/** Volume capacity, when it could be read. */
export type DiskSpace = { freeBytes: number; totalBytes: number }

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}

/**
 * The line to log about workspace pressure, or null when there is nothing to
 * say. Pure, so the thresholds are testable without a filesystem.
 *
 * Deliberately REPORTS and does not BOUND. Bounding means deleting a user's
 * checkouts on a rule nobody chose; the retention setting that already exists
 * (`workspace_autocleanup_enabled`) is the place for that decision, and it
 * defaults to off. Turning it on silently is not this change's to make.
 */
export function workspacePressureWarning(input: { count: number; disk?: DiskSpace }): string | null {
  const { count, disk } = input
  const countHigh = count >= WORKSPACE_COUNT_WARN_THRESHOLD
  // No zero-guard needed on the division: 0/0 is NaN and x/0 is Infinity, and
  // neither is `< WORKSPACE_FREE_SPACE_WARN_FRACTION`. A guard here would be
  // dead code that reads as a guard. The one in the message body below is NOT
  // dead — without it an unreadable volume prints "NaN%".
  const spaceLow = disk !== undefined && disk.freeBytes / disk.totalBytes < WORKSPACE_FREE_SPACE_WARN_FRACTION
  if (!countHigh && !spaceLow) return null

  const parts = [`${count} task workspaces on disk, each with its own node_modules`]
  if (disk !== undefined && disk.totalBytes > 0) {
    const percent = ((disk.freeBytes / disk.totalBytes) * 100).toFixed(0)
    parts.push(`${formatGiB(disk.freeBytes)} free of ${formatGiB(disk.totalBytes)} (${percent}%)`)
  }
  parts.push('Enable workspace auto-cleanup in Settings')
  return `${spaceLow ? 'DISK NEARLY FULL. ' : ''}${parts.join('. ')}.`
}
