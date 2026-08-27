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

/** The workspace directory names present on disk right now. */
export function listWorkspaceDirs(): string[] {
  try {
    if (!existsSync(WORKSPACES_DIR)) return []
    return readdirSync(WORKSPACES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}
