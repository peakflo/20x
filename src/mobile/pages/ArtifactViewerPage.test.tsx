import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { ArtifactContentKind, ArtifactType } from '@shared/artifacts'
import { ArtifactViewerPage } from './ArtifactViewerPage'
import { api } from '../api/client'
import { useArtifactStore } from '../stores/artifact-store'

const writeText = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  useArtifactStore.setState({ artifactsByTask: new Map(), loadingTaskIds: new Set() })
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true
  })
})

describe('ArtifactViewerPage', () => {
  it('renders a URL-only image artifact without requesting workspace content', () => {
    useArtifactStore.setState({
      artifactsByTask: new Map([['task-1', [{
        id: 'task-1:image:screenshot',
        taskId: 'task-1',
        type: ArtifactType.IMAGE,
        title: 'Screenshot',
        url: 'https://example.com/screenshot.png',
        updatedAt: 1,
        reloadTrigger: 0
      }]]])
    })

    const { getByRole } = render(
      <ArtifactViewerPage
        taskId="task-1"
        artifactId="task-1:image:screenshot"
        onNavigate={vi.fn()}
      />
    )

    expect(getByRole('img', { name: 'Screenshot' }).getAttribute('src')).toBe(
      'https://example.com/screenshot.png'
    )
  })

  it('copies the content of the artifact on screen', async () => {
    useArtifactStore.setState({
      artifactsByTask: new Map([['task-1', [{
        id: 'task-1:markdown:review',
        taskId: 'task-1',
        type: ArtifactType.MARKDOWN,
        title: 'Review notes',
        path: 'reports/review.md',
        updatedAt: 1,
        reloadTrigger: 0
      }]]])
    })
    vi.mocked(api.artifacts.content).mockResolvedValue({
      kind: ArtifactContentKind.TEXT,
      content: '# Review notes'
    })

    const { getByRole } = render(
      <ArtifactViewerPage taskId="task-1" artifactId="task-1:markdown:review" onNavigate={vi.fn()} />
    )

    await waitFor(() => expect(api.artifacts.content).toHaveBeenCalledWith('task-1', 'reports/review.md'))
    fireEvent.click(getByRole('button', { name: 'Copy content' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# Review notes'))
  })

  it('copies the pull request link when the artifact has no file', async () => {
    useArtifactStore.setState({
      artifactsByTask: new Map([['task-1', [{
        id: 'task-1:pr:1',
        taskId: 'task-1',
        type: ArtifactType.PR,
        title: 'Pull request',
        url: 'https://github.com/peakflo/20x/pull/1',
        updatedAt: 1,
        reloadTrigger: 0
      }]]])
    })

    const { getByRole, queryByRole } = render(
      <ArtifactViewerPage taskId="task-1" artifactId="task-1:pr:1" onNavigate={vi.fn()} />
    )

    expect(queryByRole('button', { name: 'Save file' })).toBeNull()
    fireEvent.click(getByRole('button', { name: 'Copy link' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://github.com/peakflo/20x/pull/1'))
  })
})
