import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { ArtifactContentKind, ArtifactType, type Artifact, type ArtifactApi, type ArtifactUIState } from '@shared/artifacts'
import { PinnedArtifactTabId } from '@/stores/artifact-store'
import { ACTIVE_ARTIFACT_REFRESH_INTERVAL_MS, ArtifactsPanel } from './ArtifactsPanel'

const artifactApi: ArtifactApi = {
  scan: vi.fn().mockResolvedValue([]),
  read: vi.fn().mockResolvedValue(null)
}

const baseUi: ArtifactUIState = {
  open: true,
  activeTabId: PinnedArtifactTabId.DETAILS,
  railExpanded: false
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ArtifactsPanel', () => {
  it('mounts Changes only while the Changes tab is selected', () => {
    const props = {
      taskId: 'task-1',
      artifacts: [],
      artifactApi,
      hasChanges: true,
      hasOutput: false,
      onSelectTab: vi.fn(),
      onCloseTab: vi.fn(),
      onToggleOpen: vi.fn(),
      onToggleRail: vi.fn(),
      details: <div>Task details</div>,
      changes: <div>Loaded changes</div>,
      output: null
    }
    const { rerender } = render(<ArtifactsPanel {...props} ui={baseUi} />)

    expect(screen.getByText('Task details')).toBeInTheDocument()
    expect(screen.queryByText('Loaded changes')).not.toBeInTheDocument()

    rerender(<ArtifactsPanel {...props} ui={{ ...baseUi, activeTabId: PinnedArtifactTabId.CHANGES }} />)
    expect(screen.getByText('Loaded changes')).toBeInTheDocument()

    rerender(<ArtifactsPanel {...props} ui={baseUi} />)
    expect(screen.queryByText('Loaded changes')).not.toBeInTheDocument()
  })

  it('refreshes on open and periodically only while the artifact is selected', async () => {
    const dynamicArtifactApi: ArtifactApi = {
      scan: vi.fn().mockResolvedValue([]),
      read: vi.fn().mockResolvedValue({ kind: ArtifactContentKind.TEXT, content: '# Current content' })
    }
    const artifact: Artifact = {
      id: 'artifact-1',
      taskId: 'task-1',
      type: ArtifactType.MARKDOWN,
      title: 'Review notes',
      path: 'review.md',
      updatedAt: 1,
      reloadTrigger: 0
    }
    let intervalCallback: (() => void) | undefined
    const intervalSpy = vi.spyOn(window, 'setInterval').mockImplementation((callback, timeout) => {
      if (timeout === ACTIVE_ARTIFACT_REFRESH_INTERVAL_MS) intervalCallback = callback as () => void
      return 1 as unknown as ReturnType<typeof window.setInterval>
    })
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined)
    const props = {
      taskId: 'task-1',
      artifacts: [artifact],
      artifactApi: dynamicArtifactApi,
      hasChanges: true,
      hasOutput: false,
      onSelectTab: vi.fn(),
      onCloseTab: vi.fn(),
      onToggleOpen: vi.fn(),
      onToggleRail: vi.fn(),
      details: <div>Task details</div>,
      changes: <div>Loaded changes</div>,
      output: null
    }
    const { rerender } = render(<ArtifactsPanel {...props} ui={{ ...baseUi, activeTabId: artifact.id }} />)

    await waitFor(() => expect(dynamicArtifactApi.read).toHaveBeenCalledTimes(1))
    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), ACTIVE_ARTIFACT_REFRESH_INTERVAL_MS)

    act(() => intervalCallback?.())
    await waitFor(() => expect(dynamicArtifactApi.read).toHaveBeenCalledTimes(2))

    rerender(<ArtifactsPanel {...props} ui={baseUi} />)
    expect(clearIntervalSpy).toHaveBeenCalledWith(1)

    rerender(<ArtifactsPanel {...props} ui={{ ...baseUi, activeTabId: artifact.id }} />)
    await waitFor(() => expect(dynamicArtifactApi.read).toHaveBeenCalledTimes(3))

    rerender(<ArtifactsPanel {...props} artifacts={[{ ...artifact, reloadTrigger: 1 }]} ui={{ ...baseUi, activeTabId: artifact.id }} />)
    await waitFor(() => expect(dynamicArtifactApi.read).toHaveBeenCalledTimes(4))
  })
})
