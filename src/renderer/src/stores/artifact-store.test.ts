import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactContentKind, ArtifactType, type ArtifactApi } from '@shared/artifacts'
import type { TranscriptPartRecord } from '@/types/electron'
import { artifactsFromMessage, useArtifactStore } from './artifact-store'

function part(tool: Record<string, unknown>, overrides: Partial<TranscriptPartRecord> = {}): TranscriptPartRecord {
  return {
    taskId: 'task-1',
    partId: 'part-1',
    seq: 1,
    role: 'assistant',
    content: '',
    partType: 'tool',
    tool,
    createdAt: 100,
    updatedAt: 100,
    rev: 1,
    ...overrides
  }
}

beforeEach(() => {
  localStorage.clear()
  useArtifactStore.setState({ artifactsByTask: {}, uiByTask: {}, turnsByTask: {}, hydratedTasks: {} })
})

describe('artifact projector', () => {
  it('projects completed write tools and ignores pending updates', () => {
    const completed = artifactsFromMessage('task-1', part({
      name: 'Write', status: 'completed', input: JSON.stringify({ file_path: './docs/result.md' })
    }))
    const pending = artifactsFromMessage('task-1', part({
      name: 'Write', status: 'pending', input: JSON.stringify({ file_path: 'docs/draft.md' })
    }))

    expect(completed).toEqual([expect.objectContaining({ type: ArtifactType.MARKDOWN, path: 'docs/result.md', title: 'result.md' })])
    expect(pending).toEqual([])
  })

  it('normalizes absolute task-workspace paths to IPC-safe relative paths', () => {
    const projected = artifactsFromMessage('task-1', part({
      name: 'Edit',
      status: 'success',
      input: { file_path: '/Users/test/App Data/workspaces/task-1/repo/docs/result.html' }
    }))
    expect(projected[0]).toEqual(expect.objectContaining({ path: 'repo/docs/result.html', type: ArtifactType.HTML }))
  })

  it('recognizes pull-request URLs in successful tool output', () => {
    const projected = artifactsFromMessage('task-1', part({
      name: 'command', status: 'success', output: 'Created https://github.com/peakflo/20x/pull/42'
    }))
    expect(projected).toEqual([expect.objectContaining({ type: ArtifactType.PR, url: 'https://github.com/peakflo/20x/pull/42' })])
  })
})

describe('useArtifactStore', () => {
  it('updates an existing path and bumps its reload trigger only for a newer revision', () => {
    const store = useArtifactStore.getState()
    const first = store.upsertArtifact({ taskId: 'task-1', type: ArtifactType.HTML, title: 'demo.html', path: 'demo.html', updatedAt: 10 })
    const duplicate = store.upsertArtifact({ taskId: 'task-1', type: ArtifactType.HTML, title: 'demo.html', path: 'demo.html', updatedAt: 10 })
    const updated = store.upsertArtifact({ taskId: 'task-1', type: ArtifactType.HTML, title: 'demo.html', path: 'demo.html', updatedAt: 11 })

    expect(duplicate.id).toBe(first.id)
    expect(duplicate.reloadTrigger).toBe(0)
    expect(updated.reloadTrigger).toBe(1)
    expect(useArtifactStore.getState().getArtifacts('task-1')).toHaveLength(1)
  })

  it('follows agent artifacts until the user manually selects a tab in that turn', () => {
    const store = useArtifactStore.getState()
    store.beginTurn('task-1')
    const first = store.upsertArtifact({ taskId: 'task-1', type: ArtifactType.MARKDOWN, title: 'one.md', path: 'one.md', updatedAt: 1 }, true)
    expect(useArtifactStore.getState().getUI('task-1').activeTabId).toBe(first.id)

    store.selectTab('task-1', 'details')
    store.upsertArtifact({ taskId: 'task-1', type: ArtifactType.HTML, title: 'two.html', path: 'two.html', updatedAt: 2 }, true)
    expect(useArtifactStore.getState().getUI('task-1').activeTabId).toBe('details')

    store.endTurn('task-1')
    store.beginTurn('task-1')
    const third = store.upsertArtifact({ taskId: 'task-1', type: ArtifactType.FILE, title: 'three.txt', path: 'three.txt', updatedAt: 3 }, true)
    expect(useArtifactStore.getState().getUI('task-1').activeTabId).toBe(third.id)
  })

  it('hydrates the registry through the artifact API without following the result', async () => {
    const api: ArtifactApi = {
      scan: vi.fn().mockResolvedValue([{ path: 'report.md', title: 'report.md', type: ArtifactType.MARKDOWN, updatedAt: 5, size: 20 }]),
      read: vi.fn().mockResolvedValue({ kind: ArtifactContentKind.TEXT, content: '# Report' })
    }
    await useArtifactStore.getState().hydrate('task-1', api)
    expect(api.scan).toHaveBeenCalledWith('task-1')
    expect(useArtifactStore.getState().getArtifacts('task-1')).toEqual([expect.objectContaining({ path: 'report.md' })])
    expect(useArtifactStore.getState().getUI('task-1').activeTabId).toBeNull()
    expect(useArtifactStore.getState().hydratedTasks['task-1']).toBe(true)
  })

  it('hydrates large workspaces atomically and deduplicates StrictMode calls', async () => {
    const entries = Array.from({ length: 500 }, (_, index) => ({
      path: `repo/file-${index}.ts`,
      title: `file-${index}.ts`,
      type: ArtifactType.FILE,
      updatedAt: index + 1,
      size: 20
    }))
    const api: ArtifactApi = {
      scan: vi.fn().mockResolvedValue(entries),
      read: vi.fn()
    }
    const subscriber = vi.fn()
    const unsubscribe = useArtifactStore.subscribe(subscriber)

    await Promise.all([
      useArtifactStore.getState().hydrate('task-1', api),
      useArtifactStore.getState().hydrate('task-1', api)
    ])

    unsubscribe()
    expect(api.scan).toHaveBeenCalledTimes(1)
    expect(subscriber).toHaveBeenCalledTimes(2)
    expect(useArtifactStore.getState().getArtifacts('task-1')).toHaveLength(500)
  })
})
