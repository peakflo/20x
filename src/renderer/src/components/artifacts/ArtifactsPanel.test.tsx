import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ArtifactApi, ArtifactUIState } from '@shared/artifacts'
import { PinnedArtifactTabId } from '@/stores/artifact-store'
import { ArtifactsPanel } from './ArtifactsPanel'

const artifactApi: ArtifactApi = {
  scan: vi.fn().mockResolvedValue([]),
  read: vi.fn().mockResolvedValue(null)
}

const baseUi: ArtifactUIState = {
  open: true,
  activeTabId: PinnedArtifactTabId.DETAILS,
  railExpanded: false
}

afterEach(cleanup)

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
})
