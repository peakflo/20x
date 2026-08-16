/**
 * Cleanup of leaked stdio MCP server processes.
 *
 * Every agent session attaches the task-management MCP server as a stdio child
 * process. Those children exit only when the process that owns their stdin pipe
 * exits, so they survive for as long as the agent CLI or the shared
 * `opencode serve` process does — hours or days.
 *
 * Shutdown used to run a blind `pkill -f task-management-mcp.js`. With two 20x
 * instances running (a packaged app and a dev build, which is normal on a
 * developer machine) quitting one instance killed the live MCP children of the
 * other, and its running agents lost every task-management tool. The selection
 * below is therefore scoped: only our own descendants, plus processes that have
 * already lost their parent, are killed.
 */

/** One row of the process table. */
export type ProcessRow = { pid: number; ppid: number; command: string }

/** The stdio MCP servers 20x spawns. Matched as a substring of the command. */
export const MCP_SCRIPT_MARKERS = ['task-management-mcp.js'] as const

/**
 * Parses the output of `ps -eo pid=,ppid=,command=`.
 * Rows that do not start with two integers are ignored.
 */
export function parseProcessTable(psOutput: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] })
  }
  return rows
}

/** All transitive children of `rootPid`, excluding `rootPid` itself. */
export function collectDescendantPids(rows: ProcessRow[], rootPid: number): Set<number> {
  const childrenByParent = new Map<number, number[]>()
  for (const row of rows) {
    const siblings = childrenByParent.get(row.ppid)
    if (siblings) siblings.push(row.pid)
    else childrenByParent.set(row.ppid, [row.pid])
  }

  const descendants = new Set<number>()
  const queue = [rootPid]
  while (queue.length > 0) {
    const current = queue.pop()!
    for (const child of childrenByParent.get(current) ?? []) {
      // Guard against a cyclic or self-parented table so this cannot spin.
      if (child === current || descendants.has(child)) continue
      descendants.add(child)
      queue.push(child)
    }
  }
  return descendants
}

/**
 * The MCP server processes that this instance may kill:
 *   - its own descendants, which no other instance can be using, and
 *   - orphans (ppid 1), whose owner is already gone.
 *
 * MCP servers held by a live process that is not ours are left alone.
 */
export function selectKillableMcpPids(
  rows: ProcessRow[],
  ownPid: number,
  markers: readonly string[] = MCP_SCRIPT_MARKERS
): number[] {
  const descendants = collectDescendantPids(rows, ownPid)
  const killable: number[] = []
  for (const row of rows) {
    if (row.pid === ownPid) continue
    if (!markers.some((marker) => row.command.includes(marker))) continue
    if (descendants.has(row.pid) || row.ppid === 1) killable.push(row.pid)
  }
  return killable
}
