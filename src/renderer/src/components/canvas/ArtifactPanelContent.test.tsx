import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ArtifactType, type Artifact } from '@shared/artifacts'
import { ArtifactPanelContent } from './ArtifactPanelContent'
import { useCanvasStore } from '@/stores/canvas-store'
import { useArtifactStore } from '@/stores/artifact-store'

const { registerPanelMock, readMock } = vi.hoisted(() => ({
  registerPanelMock: vi.fn(async () => ({ success: true })),
  readMock: vi.fn(async () => ({ kind: 'text', /* ArtifactContentKind.TEXT */ content: '# Quarterly report\n\nRevenue grew.' })),
}))

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn() } }))

vi.mock('@/lib/ipc-client', () => ({
  settingsApi: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
  artifactApi: { scan: vi.fn(async () => []), read: readMock },
  onArtifactUpdated: vi.fn(() => vi.fn()),
}))

vi.mock('@/stores/task-store', () => {
  const state = { tasks: [{ id: 'owner-task', title: 'Owner Task' }] }
  const useTaskStore = (selector: (s: typeof state) => unknown) => selector(state)
  useTaskStore.getState = () => state
  return { useTaskStore }
})

const artifact: Artifact = {
  id: 'owner-task:report',
  taskId: 'owner-task',
  type: ArtifactType.MARKDOWN,
  title: 'Report',
  path: 'report.md',
  updatedAt: 1,
  reloadTrigger: 0,
}

describe('ArtifactPanelContent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window.electronAPI as unknown as Record<string, unknown>).canvasArtifacts = {
      registerPanel: registerPanelMock,
      unregisterPanel: vi.fn(async () => ({ success: true })),
    }
    useArtifactStore.setState((s) => ({
      ...s,
      artifactsByTask: { 'owner-task': [artifact] },
      hydratedTasks: { 'owner-task': true },
    }))
    useCanvasStore.setState({
      panels: [
        { id: 'owner-panel', type: 'task', title: 'Owner Task', refId: 'owner-task', x: 0, y: 0, width: 400, height: 400, zIndex: 1 },
        { id: 'reader-panel', type: 'task', title: 'Reader Task', refId: 'reader-task', x: 900, y: 0, width: 400, height: 400, zIndex: 2 },
        { id: 'artifact-panel', type: 'artifact', title: 'Report', refId: artifact.id, artifactTaskId: 'owner-task', x: 450, y: 0, width: 400, height: 400, zIndex: 3 },
      ],
      edges: [{ id: 'e1', fromPanelId: 'owner-panel', toPanelId: 'artifact-panel', edgeType: 'artifact' }],
      connectingFromId: null,
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders the artifact with its owning task and registers it with no connected tasks', async () => {
    render(<ArtifactPanelContent panelId="artifact-panel" artifactId={artifact.id} taskId="owner-task" />)

    expect(await screen.findByText('Revenue grew.')).toBeInTheDocument()
    expect(screen.getByText('Owner Task')).toBeInTheDocument()
    expect(screen.getByTestId('artifact-panel-connections')).toHaveTextContent('No tasks connected')
    expect(readMock).toHaveBeenCalledWith('owner-task', 'report.md')
    await waitFor(() => expect(registerPanelMock).toHaveBeenLastCalledWith(expect.objectContaining({
      panelId: 'artifact-panel',
      ownerTaskId: 'owner-task',
      artifactId: artifact.id,
      path: 'report.md',
      files: ['report.md'],
      taskIds: [],
    })))
  })

  it('re-registers connected tasks when a task panel is connected', async () => {
    render(<ArtifactPanelContent panelId="artifact-panel" artifactId={artifact.id} taskId="owner-task" />)
    await screen.findByText('Revenue grew.')

    act(() => {
      useCanvasStore.setState((s) => ({
        edges: [...s.edges, { id: 'e2', fromPanelId: 'reader-panel', toPanelId: 'artifact-panel', edgeType: 'artifact' }],
      }))
    })

    expect(screen.getByTestId('artifact-panel-connections')).toHaveTextContent('Shared with Reader Task')
    await waitFor(() => expect(registerPanelMock).toHaveBeenLastCalledWith(expect.objectContaining({ taskIds: ['reader-task'] })))
  })

  it('enters connection mode from the Connect task action', () => {
    render(<ArtifactPanelContent panelId="artifact-panel" artifactId={artifact.id} taskId="owner-task" />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect a task to this artifact' }))
    expect(useCanvasStore.getState().connectingFromId).toBe('artifact-panel')
  })

  it('shows a placeholder when the artifact is missing', () => {
    useArtifactStore.setState((s) => ({ ...s, artifactsByTask: { 'owner-task': [] } }))
    render(<ArtifactPanelContent panelId="artifact-panel" artifactId={artifact.id} taskId="owner-task" />)
    expect(screen.getByTestId('artifact-panel-missing')).toBeInTheDocument()
    expect(registerPanelMock).not.toHaveBeenCalled()
  })
})
