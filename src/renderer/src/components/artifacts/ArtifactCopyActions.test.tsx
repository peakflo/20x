import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  ArtifactClipboardMode,
  ArtifactContentKind,
  ArtifactType,
  type Artifact,
  type ArtifactApi
} from '@shared/artifacts'
import { ArtifactCopyActions } from './ArtifactCopyActions'

const writeText = vi.fn().mockResolvedValue(undefined)

const markdownArtifact: Artifact = {
  id: 'artifact-1',
  taskId: 'task-1',
  type: ArtifactType.MARKDOWN,
  title: 'Review notes',
  path: 'reports/review.md',
  updatedAt: 1,
  reloadTrigger: 0
}

function makeApi(overrides: Partial<ArtifactApi> = {}): ArtifactApi {
  return {
    scan: vi.fn().mockResolvedValue([]),
    read: vi.fn().mockResolvedValue({ kind: ArtifactContentKind.TEXT, content: '# Review notes' }),
    copyFile: vi.fn().mockResolvedValue({ mode: ArtifactClipboardMode.FILE }),
    ...overrides
  }
}

beforeEach(() => {
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ArtifactCopyActions', () => {
  it('copies the text content of the artifact', async () => {
    const artifactApi = makeApi()
    render(<ArtifactCopyActions artifact={markdownArtifact} artifactApi={artifactApi} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy content' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# Review notes'))
    expect(artifactApi.read).toHaveBeenCalledWith('task-1', 'reports/review.md')
    await screen.findByText('Copied')
  })

  it('copies the file itself and reports how the platform copied it', async () => {
    const artifactApi = makeApi({ copyFile: vi.fn().mockResolvedValue({ mode: ArtifactClipboardMode.PATH }) })
    render(<ArtifactCopyActions artifact={markdownArtifact} artifactApi={artifactApi} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy file' }))

    await waitFor(() => expect(artifactApi.copyFile).toHaveBeenCalledWith('task-1', 'reports/review.md'))
    await screen.findByText('Path copied')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('reports a failure when the file is no longer inside the workspace', async () => {
    const artifactApi = makeApi({ copyFile: vi.fn().mockResolvedValue({ mode: ArtifactClipboardMode.UNAVAILABLE }) })
    render(<ArtifactCopyActions artifact={markdownArtifact} artifactApi={artifactApi} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy file' }))

    await screen.findByText('Copy failed')
  })

  it('copies the link of a pull request artifact and hides the file option', async () => {
    const artifactApi = makeApi()
    const pullRequest: Artifact = {
      id: 'artifact-pr',
      taskId: 'task-1',
      type: ArtifactType.PR,
      title: 'Pull request',
      url: 'https://github.com/peakflo/20x/pull/1',
      updatedAt: 1,
      reloadTrigger: 0
    }
    render(<ArtifactCopyActions artifact={pullRequest} artifactApi={artifactApi} />)

    expect(screen.queryByRole('button', { name: 'Copy file' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://github.com/peakflo/20x/pull/1'))
    expect(artifactApi.read).not.toHaveBeenCalled()
  })

  it('hides the file option when the viewer has no desktop clipboard bridge', () => {
    render(<ArtifactCopyActions artifact={markdownArtifact} artifactApi={makeApi({ copyFile: undefined })} />)

    expect(screen.queryByRole('button', { name: 'Copy file' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy content' })).toBeInTheDocument()
  })
})
