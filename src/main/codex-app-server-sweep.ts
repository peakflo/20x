/**
 * Collection of `codex app-server` children this process started and then lost
 * the handle to.
 *
 * The Codex adapter starts one `codex app-server --stdio` per session and keeps
 * its only handle in a map keyed by session id. Two paths dropped that handle
 * while the process kept running: resuming a session overwrote the map entry
 * with a NEW child without stopping the old one, and a rejected startup RPC
 * (`initialize`, `thread/start`, `thread/resume` — each with a 30 s timeout)
 * left an already-spawned child with nothing pointing at it. Measured on the
 * owner's machine: 11 app-servers under one 20x across 7 workspaces, three of
 * them in a workspace with a single session id, each app-server carrying its
 * own duplicated `npm exec @google-cloud/observability-mcp` child.
 *
 * The adapter now stops its children on every one of those paths. This module
 * is the backstop for whatever still escapes: a DIRECT CHILD of this process
 * running `codex app-server --stdio` that the adapter is not holding cannot be
 * spoken to by anyone ever again, because the pipe that drove it is gone.
 *
 * WHAT IS DELIBERATELY NOT MATCHED, and why the scope is this narrow:
 *
 *   - Anything that is not our child. Two 20x instances on one machine (a
 *     packaged app and a dev build) are normal, and the same reasoning as in
 *     `mcp-process-cleanup.ts` applies: killing by name alone would take the
 *     other instance's live sessions with it.
 *   - Anything DEEPER than one level. The adapter always spawns app-servers
 *     directly, so depth means somebody else spawned it — an agent session
 *     running Codex as part of the user's own work, say. That is not ours to
 *     collect, and the vendored `codex` binary under a live wrapper sits at
 *     exactly that depth. Killing the wrapper takes the binary and the MCP
 *     children with it anyway; verified on a live tree.
 *   - Parentless leftovers (ppid 1). A force-quit reparents these to launchd,
 *     where they are no longer anybody's child. The `codex app-server --stdio`
 *     marker in `mcp-process-cleanup.ts` collects them at the next start, which
 *     is the only pass that can see them.
 */

import type { ProcessRow } from './mcp-process-cleanup'

/**
 * The command substring that identifies an app-server process.
 *
 * Matches both halves of the pair — `node .../bin/codex app-server --stdio` and
 * the vendored `.../bin/codex app-server --stdio` — because both end the
 * executable path with `codex` and both carry the same arguments. `codex acp`
 * (the other Codex backend) and the `codex app-server --help` health check do
 * not match.
 */
export const CODEX_APP_SERVER_MARKER = 'codex app-server --stdio'

/**
 * The app-server pids that may be killed: our own direct children running an
 * app-server that the adapter no longer holds a handle to.
 */
export function selectUntrackedAppServerPids(
  rows: readonly ProcessRow[],
  ownPid: number,
  trackedPids: ReadonlySet<number>
): number[] {
  const leaked: number[] = []
  for (const row of rows) {
    if (row.ppid !== ownPid || row.pid === ownPid) continue
    if (!row.command.includes(CODEX_APP_SERVER_MARKER)) continue
    if (trackedPids.has(row.pid)) continue
    leaked.push(row.pid)
  }
  return leaked.sort((a, b) => a - b)
}
