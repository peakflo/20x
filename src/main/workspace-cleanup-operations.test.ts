import { mkdtempSync, mkdirSync, existsSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeWorkspaceCleanupJob } from './workspace-cleanup-operations'
import { terminateProcessesInWorkspaces } from './workspace-process-cleanup'

vi.mock('./workspace-process-cleanup', async (importOriginal) => ({
  ...await importOriginal<typeof import('./workspace-process-cleanup')>(),
  terminateProcessesInWorkspaces: vi.fn(async () => [])
}))

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.mocked(terminateProcessesInWorkspaces).mockClear()
})

describe('workspace cleanup operation', () => {
  it('removes only old orphaned workspaces, after checking their processes', async () => {
    const root = mkdtempSync(join(tmpdir(), '20x-cleanup-'))
    roots.push(root)
    for (const name of ['saved', 'orphan', 'new']) mkdirSync(join(root, name))
    const old = new Date('2020-01-01')
    utimesSync(join(root, 'saved'), old, old)
    utimesSync(join(root, 'orphan'), old, old)
    const result = await executeWorkspaceCleanupJob({ kind: 'orphans', workspacesRoot: root, taskIds: ['saved'], retentionDays: 7 })
    expect(result).toEqual({ kind: 'orphans', cleaned: 1, errors: [] })
    expect(terminateProcessesInWorkspaces).toHaveBeenCalledWith({ workspacesRoot: root, workspaceIds: ['orphan'] })
    expect(existsSync(join(root, 'saved'))).toBe(true)
    expect(existsSync(join(root, 'orphan'))).toBe(false)
    expect(existsSync(join(root, 'new'))).toBe(true)
  })

  it('keeps all workspaces when task ownership cannot be checked', async () => {
    const root = mkdtempSync(join(tmpdir(), '20x-cleanup-'))
    roots.push(root)
    mkdirSync(join(root, 'possible-task'))
    expect(await executeWorkspaceCleanupJob({ kind: 'orphans', workspacesRoot: root, taskIds: [], retentionDays: 7 }))
      .toEqual({ kind: 'orphans', cleaned: 0, errors: [] })
    expect(existsSync(join(root, 'possible-task'))).toBe(true)
  })
})
