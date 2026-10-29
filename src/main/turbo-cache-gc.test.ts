import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { pruneStaleTurboCache } from './turbo-cache-gc'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('pruneStaleTurboCache', () => {
  it('removes old cache files in shared and workspace caches, but keeps recent files and linked caches', async () => {
    const root = await mkdtemp(join(tmpdir(), '20x-turbo-gc-'))
    roots.push(root)
    const reposRoot = join(root, 'repos')
    const workspacesRoot = join(root, 'workspaces')
    const shared = join(reposRoot, 'peakflo', '.turbo', 'cache')
    const workspace = join(workspacesRoot, 'task-1', 'workflow-builder', '.turbo', 'cache')
    const external = join(root, 'external', 'cache')
    await Promise.all([mkdir(shared, { recursive: true }), mkdir(workspace, { recursive: true }), mkdir(external, { recursive: true })])
    const old = join(shared, 'old.tar.zst')
    const recent = join(shared, 'new.tar.zst')
    const workspaceOld = join(workspace, 'workspace-old.tar.zst')
    const outside = join(external, 'outside.tar.zst')
    await Promise.all([writeFile(old, '1234'), writeFile(recent, 'new'), writeFile(workspaceOld, '12'), writeFile(outside, 'keep')])
    const now = Date.parse('2026-10-27T00:00:00Z')
    const oldDate = new Date(now - 20 * 86400000)
    await Promise.all([utimes(old, oldDate, oldDate), utimes(workspaceOld, oldDate, oldDate), utimes(outside, oldDate, oldDate)])
    await mkdir(join(reposRoot, 'linked'), { recursive: true })
    await symlink(join(root, 'external'), join(reposRoot, 'linked', '.turbo'))

    const result = await pruneStaleTurboCache({ reposRoot, workspacesRoot, inactiveDays: 14, now })

    expect(result).toEqual({ files: 2, bytes: 6, errors: [] })
    await expect(readFile(old)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(workspaceOld)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(recent, 'utf8')).toBe('new')
    expect(await readFile(outside, 'utf8')).toBe('keep')
  })

  it('rejects an invalid retention period', async () => {
    const result = await pruneStaleTurboCache({ reposRoot: '/none', workspacesRoot: '/none', inactiveDays: 0 })
    expect(result.files).toBe(0)
    expect(result.errors).toHaveLength(1)
  })
})
