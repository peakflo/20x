import { app } from 'electron'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * The root every agent task workspace lives under.
 *
 * One definition, because two consumers now decide whether a path is inside it:
 * `workspace-cleanup-scheduler.ts`, which removes the directories, and
 * `workspace-process-cleanup.ts`, which kills what is still running in them. A
 * second copy that drifted would make a process look un-leaked and keep it.
 */
export const WORKSPACES_DIR = join(app.getPath('userData'), 'workspaces')

/**
 * The workspace directory names present on disk right now, or NULL when the
 * directory could not be read.
 *
 * The difference is load-bearing and this used to swallow it. `readdirSync`
 * needs a directory descriptor, so it is one of the first things to fail under
 * EMFILE — the exact condition the process sweep exists to relieve. Returning
 * `[]` there told the caller "no workspace exists", which marks EVERY task's
 * workspace as removed and switches off the guard that protects a task an agent
 * is working on right now. The sweep would have been at its most destructive on
 * precisely the machine it was written for. EACCES and a transient rename did
 * the same thing.
 *
 * An absent root is still `[]` — that is a real, readable answer.
 */
export function listWorkspaceDirs(): string[] | null {
  try {
    if (!existsSync(WORKSPACES_DIR)) return []
    return readdirSync(WORKSPACES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch (err) {
    console.warn('[WorkspaceCleanup] Could not list the workspaces directory:', err)
    return null
  }
}
