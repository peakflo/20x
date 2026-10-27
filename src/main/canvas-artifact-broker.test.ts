import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CanvasArtifactBroker, type ArtifactReadDeps } from './canvas-artifact-broker'
import { ArtifactContentKind, ArtifactType } from '../shared/artifacts'

const files = ['artifacts/report/index.html', 'artifacts/report/chart.png']

function makeDeps(overrides: Partial<ArtifactReadDeps> = {}): ArtifactReadDeps {
  return {
    getWorkspaceDir: vi.fn((taskId: string) => `/ws/${taskId}`),
    listEntries: vi.fn(async () => [
      { path: files[0], title: 'Report', type: ArtifactType.HTML, updatedAt: 1, size: 10, files }
    ]),
    readArtifact: vi.fn(async (_dir: string, path: string) => ({ kind: ArtifactContentKind.TEXT, content: `content of ${path}`, mimeType: 'text/html' })),
    ...overrides
  }
}

describe('CanvasArtifactBroker', () => {
  let broker: CanvasArtifactBroker

  beforeEach(() => {
    broker = new CanvasArtifactBroker()
    broker.register({
      panelId: 'panel-a',
      ownerTaskId: 'owner',
      artifactId: 'owner:workpiece:report',
      title: 'Report',
      type: ArtifactType.HTML,
      path: files[0],
      files,
      taskIds: ['reader']
    })
  })

  it('rejects malformed registrations', () => {
    expect(broker.register({ panelId: '', ownerTaskId: 'o', artifactId: 'a', title: '', type: 'file', taskIds: [] })).toBe(false)
    expect(broker.register({ panelId: 'p', ownerTaskId: '', artifactId: 'a', title: '', type: 'file', taskIds: [] })).toBe(false)
  })

  it('lists only artifact panels connected to the calling task', () => {
    expect(broker.list('reader')).toEqual([
      expect.objectContaining({ panel_id: 'panel-a', owner_task_id: 'owner', title: 'Report', entry_file: files[0], files })
    ])
    expect(broker.list('stranger')).toEqual([])
  })

  it('reads the entry file by default from the owner task workspace', async () => {
    const deps = makeDeps()
    const result = await broker.read('reader', {}, deps)
    expect(result).toMatchObject({ panel_id: 'panel-a', owner_task_id: 'owner', file: files[0], content: { content: `content of ${files[0]}` } })
    expect(deps.getWorkspaceDir).toHaveBeenCalledWith('owner')
    expect(deps.readArtifact).toHaveBeenCalledWith('/ws/owner', files[0])
  })

  it('refuses tasks that are not connected', async () => {
    const deps = makeDeps()
    expect(await broker.read('stranger', {}, deps)).toEqual({ error: expect.stringContaining('No artifact panel') })
    expect(await broker.read('stranger', { panelId: 'panel-a' }, deps)).toEqual({ error: expect.stringContaining('not connected') })
    expect(deps.readArtifact).not.toHaveBeenCalled()
  })

  it('refuses files outside the artifact and files no longer owned on disk', async () => {
    expect(await broker.read('reader', { file: '../secrets.txt' }, makeDeps())).toEqual({ error: expect.stringContaining('not a file of this artifact') })
    const staleDeps = makeDeps({ listEntries: vi.fn(async () => []) })
    expect(await broker.read('reader', { file: files[1] }, staleDeps)).toEqual({ error: expect.stringContaining('no longer') })
    expect(staleDeps.readArtifact).not.toHaveBeenCalled()
  })

  it('asks for panel_id when several artifacts are connected, and forgets unregistered panels', async () => {
    broker.register({ panelId: 'panel-b', ownerTaskId: 'owner', artifactId: 'x', title: 'X', type: 'file', path: 'x.md', taskIds: ['reader'] })
    expect(await broker.read('reader', {}, makeDeps())).toEqual({ error: expect.stringContaining('Pass panel_id') })
    broker.unregister('panel-b')
    expect(broker.list('reader').map((a) => a.panel_id)).toEqual(['panel-a'])
  })

  it('updates connections on re-registration', () => {
    broker.register({ panelId: 'panel-a', ownerTaskId: 'owner', artifactId: 'owner:workpiece:report', title: 'Report', type: 'html', path: files[0], files, taskIds: [] })
    expect(broker.list('reader')).toEqual([])
  })
})
