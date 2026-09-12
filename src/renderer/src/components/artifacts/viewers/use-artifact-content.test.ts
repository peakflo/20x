import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ArtifactContentKind, ArtifactType, type Artifact, type ArtifactContent } from '@shared/artifacts'
import { useArtifactContent } from './use-artifact-content'

afterEach(cleanup)

it('finishes loading when returning to a file before the next file loads', async () => {
  let finishOther!: (value: ArtifactContent) => void
  const other = new Promise<ArtifactContent>((resolve) => { finishOther = resolve })
  const api = { scan: vi.fn(), read: vi.fn().mockImplementation(async (_task, path) => path === 'other.md' ? other : { kind: ArtifactContentKind.TEXT, content: 'Start' }) }
  const artifact: Artifact = { id: 'demo', taskId: 'task', title: 'Demo', type: ArtifactType.MARKDOWN, path: 'start.md', updatedAt: 1, reloadTrigger: 0 }
  const { result, rerender } = renderHook(({ path }) => useArtifactContent({ ...artifact, path }, api), { initialProps: { path: 'start.md' } })
  await waitFor(() => expect(result.current.loading).toBe(false))
  rerender({ path: 'other.md' })
  expect(result.current.loading).toBe(true)
  rerender({ path: 'start.md' })
  await waitFor(() => expect(result.current.loading).toBe(false))
  await act(async () => finishOther({ kind: ArtifactContentKind.TEXT, content: 'Other' }))
  expect(result.current.content?.content).toBe('Start')
})
