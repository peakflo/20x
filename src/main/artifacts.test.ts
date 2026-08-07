import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArtifactContentKind, ArtifactType } from '../shared/artifacts'
import {
  ARTIFACT_FILE_LIMITS,
  createRegisteredTaskArtifact,
  editRegisteredTaskArtifactFile,
  inspectTaskArtifact,
  listRegisteredTaskArtifacts,
  listTaskArtifactEntries,
  readRegisteredTaskArtifactFile,
  readTaskArtifact,
  scanTaskArtifacts,
  writeRegisteredTaskArtifactFile
} from './artifacts'

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

  it('scans preview artifacts with stable relative paths and skips source, generated, and dependency files', async () => {
    await mkdir(join(workspaceDir, 'reports'))
    await mkdir(join(workspaceDir, 'repo', 'docs'), { recursive: true })
    await mkdir(join(workspaceDir, 'node_modules', 'package'), { recursive: true })
    await writeFile(join(workspaceDir, 'AGENTS.md'), 'generated instructions')
    await writeFile(join(workspaceDir, 'heartbeat.md'), '# Internal monitoring')
    await writeFile(join(workspaceDir, 'reports', 'summary.md'), '# Summary')
    await writeFile(join(workspaceDir, 'reports', 'preview.html'), '<h1>Preview</h1>')
    await writeFile(join(workspaceDir, 'reports', 'chart.png'), Buffer.from([1, 2, 3]))
    await writeFile(join(workspaceDir, 'reports', 'notes.txt'), 'notes')
    await writeFile(join(workspaceDir, 'repo', 'docs', 'source.md'), 'repository documentation')
    await writeFile(join(workspaceDir, 'repo', 'preview.html'), '<h1>Repository source</h1>')
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

  it('groups a multi-file output directory into one logical artifact', async () => {
    await mkdir(join(workspaceDir, 'outputs', 'dashboard'), { recursive: true })
    await writeFile(join(workspaceDir, 'outputs', 'dashboard', 'README.md'), '# Dashboard')
    await writeFile(join(workspaceDir, 'outputs', 'dashboard', 'index.html'), '<main>Dashboard</main>')
    await writeFile(join(workspaceDir, 'outputs', 'dashboard', 'styles.css'), 'main { display: grid; }')

    const artifacts = await scanTaskArtifacts(workspaceDir)

    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toEqual(expect.objectContaining({
      path: 'outputs/dashboard/index.html',
      title: 'dashboard',
      type: ArtifactType.HTML,
      workpieceKey: 'outputs/dashboard'
    }))
  })

  it('registers one durable workpiece and keeps multiple owned files behind its stable identity', async () => {
    const registered = await createRegisteredTaskArtifact(workspaceDir, 'task-1', {
      title: 'Sales dashboard',
      type: ArtifactType.HTML
    })

    const first = await writeRegisteredTaskArtifactFile(workspaceDir, 'task-1', {
      artifactId: registered.artifactId,
      filename: 'styles.css',
      content: 'main { display: grid; }'
    })
    const preview = await writeRegisteredTaskArtifactFile(workspaceDir, 'task-1', {
      artifactId: registered.artifactId,
      filename: 'index.html',
      content: '<main>Before</main>',
      preview: true
    })

    expect(first.id).toBe(preview.id)
    expect(preview).toEqual(expect.objectContaining({
      id: `task-1:workpiece:${encodeURIComponent(registered.artifactId)}`,
      title: 'Sales dashboard',
      type: ArtifactType.HTML,
      path: `artifacts/${registered.artifactId}/index.html`,
      workpieceKey: registered.artifactId
    }))
    await expect(listRegisteredTaskArtifacts(workspaceDir, 'task-1')).resolves.toEqual([
      expect.objectContaining({
        artifactId: registered.artifactId,
        files: ['index.html', 'styles.css'],
        entryFile: 'index.html'
      })
    ])
    await expect(listTaskArtifactEntries(workspaceDir, 'task-1')).resolves.toEqual([
      expect.objectContaining({
        path: `artifacts/${registered.artifactId}/index.html`,
        workpieceKey: registered.artifactId
      })
    ])
  })

  it('reads and exact-edits registered files while enforcing task and path boundaries', async () => {
    const registered = await createRegisteredTaskArtifact(workspaceDir, 'task-1', {
      title: 'Report',
      type: ArtifactType.MARKDOWN
    })
    await writeRegisteredTaskArtifactFile(workspaceDir, 'task-1', {
      artifactId: registered.artifactId,
      filename: 'report.md',
      content: '# Before'
    })

    await editRegisteredTaskArtifactFile(workspaceDir, 'task-1', {
      artifactId: registered.artifactId,
      filename: 'report.md',
      textToReplace: 'Before',
      replacement: 'After'
    })
    await expect(readRegisteredTaskArtifactFile(workspaceDir, 'task-1', registered.artifactId, 'report.md')).resolves.toEqual({
      content: '# After',
      encoding: 'utf8',
      mimeType: 'text/markdown'
    })
    await expect(readRegisteredTaskArtifactFile(workspaceDir, 'task-2', registered.artifactId, 'report.md')).rejects.toThrow('Artifact not found')
    await expect(writeRegisteredTaskArtifactFile(workspaceDir, 'task-1', {
      artifactId: registered.artifactId,
      filename: '../escape.md',
      content: 'nope'
    })).rejects.toThrow('Invalid artifact ID or filename')

    const outsideFile = join(testRoot, 'outside-registered.md')
    await writeFile(outsideFile, 'secret')
    await symlink(outsideFile, join(workspaceDir, 'artifacts', registered.artifactId, 'linked.md'))
    await expect(readRegisteredTaskArtifactFile(workspaceDir, 'task-1', registered.artifactId, 'linked.md'))
      .rejects.toThrow('Invalid artifact ID or filename')
    await expect(writeRegisteredTaskArtifactFile(workspaceDir, 'task-1', {
      artifactId: registered.artifactId,
      filename: 'linked.md',
      content: 'overwrite'
    })).rejects.toThrow('Invalid artifact ID or filename')
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('secret')
  })

  it('rejects symlinked registry and artifact directories before writing outside the workspace', async () => {
    const outsideRegistry = join(testRoot, 'outside-registry')
    await mkdir(outsideRegistry)
    await symlink(outsideRegistry, join(workspaceDir, '.20x'))

    await expect(createRegisteredTaskArtifact(workspaceDir, 'task-1', {
      title: 'Unsafe registry',
      type: ArtifactType.MARKDOWN
    })).rejects.toThrow('Unsafe artifact directory')
    await expect(readdir(outsideRegistry)).resolves.toEqual([])

    await rm(join(workspaceDir, '.20x'))
    const outsideArtifacts = join(testRoot, 'outside-artifacts')
    await mkdir(outsideArtifacts)
    await symlink(outsideArtifacts, join(workspaceDir, 'artifacts'))

    await expect(createRegisteredTaskArtifact(workspaceDir, 'task-1', {
      title: 'Unsafe files',
      type: ArtifactType.MARKDOWN
    })).rejects.toThrow('Unsafe artifact directory')
    await expect(readdir(outsideArtifacts)).resolves.toEqual([])
  })

  it('rejects a symlinked registry file without reading or replacing its target', async () => {
    const outsideRegistryFile = join(testRoot, 'outside-artifacts.json')
    const outsideContent = '{"version":1,"artifacts":[]}'
    await writeFile(outsideRegistryFile, outsideContent)
    await mkdir(join(workspaceDir, '.20x'))
    await symlink(outsideRegistryFile, join(workspaceDir, '.20x', 'artifacts.json'))

    await expect(listRegisteredTaskArtifacts(workspaceDir, 'task-1')).rejects.toThrow('Unsafe artifact registry')
    await expect(createRegisteredTaskArtifact(workspaceDir, 'task-1', {
      title: 'Unsafe registry file',
      type: ArtifactType.MARKDOWN
    })).rejects.toThrow('Unsafe artifact registry')
    await expect(readFile(outsideRegistryFile, 'utf8')).resolves.toBe(outsideContent)
  })

  it('rejects a symlinked nested artifact directory before creating files through it', async () => {
    const registered = await createRegisteredTaskArtifact(workspaceDir, 'task-1', {
      title: 'Report',
      type: ArtifactType.MARKDOWN
    })
    const outsideDirectory = join(testRoot, 'outside-files')
    await mkdir(outsideDirectory)
    await symlink(outsideDirectory, join(workspaceDir, 'artifacts', registered.artifactId, 'nested'))

    await expect(writeRegisteredTaskArtifactFile(workspaceDir, 'task-1', {
      artifactId: registered.artifactId,
      filename: 'nested/escape.md',
      content: 'secret'
    })).rejects.toThrow('Unsafe artifact directory')
    await expect(readdir(outsideDirectory)).resolves.toEqual([])
  })

  it('inspects only a tool-reported file inside the workspace', async () => {
    await mkdir(join(workspaceDir, 'repo'))
    const reportPath = join(workspaceDir, 'repo', 'report.md')
    const outsideFile = join(testRoot, 'outside.md')
    await writeFile(reportPath, '# Result')
    await writeFile(outsideFile, 'secret')

    await expect(inspectTaskArtifact(workspaceDir, reportPath)).resolves.toEqual(
      expect.objectContaining({ path: 'repo/report.md', type: ArtifactType.MARKDOWN })
    )
    await expect(inspectTaskArtifact(workspaceDir, outsideFile)).resolves.toBeNull()
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
