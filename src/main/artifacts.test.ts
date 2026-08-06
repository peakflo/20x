import { mkdtemp, mkdir, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArtifactContentKind, ArtifactType } from '../shared/artifacts'
import { ARTIFACT_FILE_LIMITS, readTaskArtifact, scanTaskArtifacts } from './artifacts'

describe('task artifact files', () => {
  let testRoot: string
  let workspaceDir: string

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), '20x-artifacts-'))
    workspaceDir = join(testRoot, 'workspace')
    await mkdir(workspaceDir)
  })

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true })
  })

  it('scans supported files with stable relative paths and skips generated and dependency files', async () => {
    await mkdir(join(workspaceDir, 'reports'))
    await mkdir(join(workspaceDir, 'node_modules', 'package'), { recursive: true })
    await writeFile(join(workspaceDir, 'AGENTS.md'), 'generated instructions')
    await writeFile(join(workspaceDir, 'reports', 'summary.md'), '# Summary')
    await writeFile(join(workspaceDir, 'reports', 'preview.html'), '<h1>Preview</h1>')
    await writeFile(join(workspaceDir, 'reports', 'chart.png'), Buffer.from([1, 2, 3]))
    await writeFile(join(workspaceDir, 'reports', 'notes.txt'), 'notes')
    await writeFile(join(workspaceDir, 'reports', 'archive.zip'), 'not previewable')
    await writeFile(join(workspaceDir, 'node_modules', 'package', 'README.md'), 'dependency')

    const artifacts = await scanTaskArtifacts(workspaceDir)

    expect(artifacts.map(({ path, title, type }) => ({ path, title, type }))).toEqual(expect.arrayContaining([
      { path: 'reports/summary.md', title: 'summary.md', type: ArtifactType.MARKDOWN },
      { path: 'reports/preview.html', title: 'preview.html', type: ArtifactType.HTML },
      { path: 'reports/chart.png', title: 'chart.png', type: ArtifactType.IMAGE },
      { path: 'reports/notes.txt', title: 'notes.txt', type: ArtifactType.FILE }
    ]))
    expect(artifacts).toHaveLength(4)
    expect(artifacts.every((artifact) => artifact.size >= 0 && artifact.updatedAt > 0)).toBe(true)
  })

  it('does not follow symlinks while scanning', async () => {
    const outsideFile = join(testRoot, 'outside.md')
    await writeFile(outsideFile, 'secret')
    await symlink(outsideFile, join(workspaceDir, 'linked.md'))

    expect(await scanTaskArtifacts(workspaceDir)).toEqual([])
  })

  it('reads text and image content in renderer-safe transport forms', async () => {
    await writeFile(join(workspaceDir, 'report.md'), '# Result')
    await writeFile(join(workspaceDir, 'shot.png'), Buffer.from([0, 1, 2, 3]))

    await expect(readTaskArtifact(workspaceDir, 'report.md')).resolves.toEqual({
      kind: ArtifactContentKind.TEXT,
      content: '# Result',
      mimeType: 'text/markdown'
    })
    await expect(readTaskArtifact(workspaceDir, 'shot.png')).resolves.toEqual({
      kind: ArtifactContentKind.DATA_URL,
      content: 'data:image/png;base64,AAECAw==',
      mimeType: 'image/png'
    })
  })

  it('rejects traversal, absolute paths, sibling-prefix paths, and escaping symlinks', async () => {
    const outsideFile = join(testRoot, 'outside.md')
    await writeFile(outsideFile, 'secret')
    await symlink(outsideFile, join(workspaceDir, 'linked.md'))

    await expect(readTaskArtifact(workspaceDir, '../outside.md')).resolves.toBeNull()
    await expect(readTaskArtifact(workspaceDir, outsideFile)).resolves.toBeNull()
    await expect(readTaskArtifact(workspaceDir, 'C:\\outside.md')).resolves.toBeNull()
    await expect(readTaskArtifact(workspaceDir, 'linked.md')).resolves.toBeNull()
  })

  it('rejects directories, unsupported files, missing files, and oversized text previews', async () => {
    await mkdir(join(workspaceDir, 'folder'))
    await writeFile(join(workspaceDir, 'archive.zip'), 'zip')
    await writeFile(join(workspaceDir, 'large.md'), Buffer.alloc(ARTIFACT_FILE_LIMITS.maxTextBytes + 1, 65))

    await expect(readTaskArtifact(workspaceDir, 'folder')).resolves.toBeNull()
    await expect(readTaskArtifact(workspaceDir, 'archive.zip')).resolves.toBeNull()
    await expect(readTaskArtifact(workspaceDir, 'missing.md')).resolves.toBeNull()
    await expect(readTaskArtifact(workspaceDir, 'large.md')).resolves.toBeNull()
  })

  it('returns an empty scan for a missing workspace', async () => {
    await expect(scanTaskArtifacts(join(testRoot, 'missing'))).resolves.toEqual([])
  })
})
