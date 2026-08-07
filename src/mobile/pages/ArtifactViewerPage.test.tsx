import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { ArtifactType } from '@shared/artifacts'
import { ArtifactViewerPage } from './ArtifactViewerPage'
import { useArtifactStore } from '../stores/artifact-store'

beforeEach(() => {
  useArtifactStore.setState({ artifactsByTask: new Map(), loadingTaskIds: new Set() })
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
})
