import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactType, type Artifact } from '@shared/artifacts'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  handlers: new Map<string, (payload: unknown) => void>()
}))

vi.mock('../api/client', () => ({
  api: { artifacts: { list: mocks.list } }
}))

vi.mock('../api/websocket', () => ({
  onEvent: (type: string, handler: (payload: unknown) => void) => {
    mocks.handlers.set(type, handler)
    return () => mocks.handlers.delete(type)
  }
}))

import { useArtifactStore } from './artifact-store'

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'artifact-1',
    taskId: 'task-1',
    type: ArtifactType.MARKDOWN,
    title: 'report.md',
    path: 'report.md',
    updatedAt: 10,
    reloadTrigger: 10,
    ...overrides
  }
}

describe('mobile artifact store', () => {
  beforeEach(() => {
    mocks.list.mockReset()
    useArtifactStore.setState({ artifactsByTask: new Map(), loadingTaskIds: new Set() })
  })

  it('hydrates a task artifact registry from REST', async () => {
    const artifact = makeArtifact()
    mocks.list.mockResolvedValue([artifact])

    await useArtifactStore.getState().hydrate('task-1')

    expect(mocks.list).toHaveBeenCalledWith('task-1')
    expect(useArtifactStore.getState().artifactsByTask.get('task-1')).toEqual([artifact])
    expect(useArtifactStore.getState().loadingTaskIds.has('task-1')).toBe(false)
  })

  it('upserts websocket updates by identity without duplicating tabs', () => {
    const initial = makeArtifact()
    const updated = makeArtifact({ updatedAt: 20, reloadTrigger: 20 })
    useArtifactStore.getState().upsert(initial)

    mocks.handlers.get('artifact:updated')?.({ artifact: updated })

    expect(useArtifactStore.getState().artifactsByTask.get('task-1')).toEqual([updated])
  })

  it('re-hydrates from the secure REST scan for lightweight websocket hints', async () => {
    const artifact = makeArtifact()
    mocks.list.mockResolvedValue([artifact])

    mocks.handlers.get('artifact:updated')?.({ taskId: 'task-1' })
    await vi.waitFor(() => {
      expect(useArtifactStore.getState().artifactsByTask.get('task-1')).toEqual([artifact])
    })

    expect(mocks.list).toHaveBeenCalledWith('task-1')
  })

  it('does not replace a newer websocket artifact with a stale hydrate result', async () => {
    const newer = makeArtifact({ updatedAt: 30, reloadTrigger: 30 })
    const stale = makeArtifact({ updatedAt: 10, reloadTrigger: 10 })
    useArtifactStore.getState().upsert(newer)
    mocks.list.mockResolvedValue([stale])

    await useArtifactStore.getState().hydrate('task-1')

    expect(useArtifactStore.getState().artifactsByTask.get('task-1')).toEqual([newer])
  })
})
