import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TaskPanelContent } from './TaskPanelContent'

const {
  updatePanelMock,
  selectTaskMock,
  updateTaskMock,
  addPanelMock,
  addEdgeMock,
  bringToFrontMock,
  canvasState,
  taskList,
} = vi.hoisted(() => ({
  updatePanelMock: vi.fn(),
  selectTaskMock: vi.fn(),
  updateTaskMock: vi.fn(),
  addPanelMock: vi.fn(() => 'panel-new'),
  addEdgeMock: vi.fn(),
  bringToFrontMock: vi.fn(),
  canvasState: {
    panels: [
      { id: 'panel-1', type: 'task', refId: 'task-1', x: 100, y: 200, width: 1020, height: 780 },
    ] as Array<{ id: string; type: string; refId: string; x: number; y: number; width: number; height: number }>,
  },
  taskList: [
    {
      id: 'task-1',
      title: 'Current Task',
      parent_task_id: null,
      output_fields: [],
      source_id: null,
      repos: [],
      priority: 'medium',
      type: 'general',
      attachments: [],
    },
    {
      id: 'child-1',
      title: 'Child Task',
      parent_task_id: 'task-1',
      output_fields: [],
      source_id: null,
      repos: [],
      priority: 'medium',
      type: 'general',
      attachments: [],
    },
  ],
}))

vi.mock('@/components/tasks/TaskWorkspace', () => ({
  TaskWorkspace: ({
    onNavigateToTask,
    onOpenSubtaskInWindow,
  }: {
    onNavigateToTask?: (taskId: string) => void
    onOpenSubtaskInWindow?: (taskId: string) => void
  }) => (
    <>
      <button type="button" onClick={() => onNavigateToTask?.('child-1')}>
        Navigate to child
      </button>
      <button type="button" onClick={() => onOpenSubtaskInWindow?.('child-1')}>
        Open child in window
      </button>
    </>
  ),
}))

vi.mock('@/stores/canvas-store', () => {
  const store = {
    updatePanel: updatePanelMock,
    addPanel: addPanelMock,
    addEdge: addEdgeMock,
    bringToFront: bringToFrontMock,
  }
  const useCanvasStore = (selector: (state: typeof store) => unknown) => selector(store)
  useCanvasStore.getState = () => ({ ...store, panels: canvasState.panels })
  return {
    useCanvasStore,
    DEFAULT_PANEL_WIDTH: 1020,
    DEFAULT_PANEL_HEIGHT: 780,
  }
})

vi.mock('@/stores/task-store', () => {
  const state = {
    tasks: taskList,
    updateTask: updateTaskMock,
  }

  const useTaskStore = (selector: (value: typeof state) => unknown) => selector(state)
  useTaskStore.getState = () => ({
    tasks: taskList,
    selectTask: selectTaskMock,
  })

  return { useTaskStore }
})

vi.mock('@/stores/agent-store', () => ({
  useAgentStore: (selector: (state: { agents: never[] }) => unknown) => selector({ agents: [] }),
}))

vi.mock('@/stores/ui-store', () => ({
  useUIStore: () => ({
    openEditModal: vi.fn(),
    openDeleteModal: vi.fn(),
  }),
}))

vi.mock('@/stores/task-source-store', () => ({
  useTaskSourceStore: () => ({
    executeAction: vi.fn(),
  }),
}))

describe('TaskPanelContent', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    canvasState.panels = [
      { id: 'panel-1', type: 'task', refId: 'task-1', x: 100, y: 200, width: 1020, height: 780 },
    ]
  })

  it('retargets the current canvas panel when navigating to another task', () => {
    render(<TaskPanelContent panelId="panel-1" taskId="task-1" panelLayout="both" />)

    fireEvent.click(screen.getByText('Navigate to child'))

    expect(updatePanelMock).toHaveBeenCalledWith('panel-1', {
      refId: 'child-1',
      title: 'Child Task',
    })
    expect(selectTaskMock).toHaveBeenCalledWith('child-1')
  })

  it('opens a subtask as a new panel positioned to the right and linked by an edge', () => {
    render(<TaskPanelContent panelId="panel-1" taskId="task-1" panelLayout="both" />)

    fireEvent.click(screen.getByText('Open child in window'))

    expect(addPanelMock).toHaveBeenCalledWith({
      type: 'task',
      title: 'Child Task',
      refId: 'child-1',
      x: 100 + 1020 + 40, // current x + width + gap
      y: 200,
      width: 1020,
      height: 780,
    })
    expect(addEdgeMock).toHaveBeenCalledWith('panel-1', 'panel-new')
    // Does not replace the current panel
    expect(updatePanelMock).not.toHaveBeenCalled()
  })

  it('brings an existing subtask panel to the front instead of duplicating it', () => {
    canvasState.panels = [
      { id: 'panel-1', type: 'task', refId: 'task-1', x: 100, y: 200, width: 1020, height: 780 },
      { id: 'panel-2', type: 'task', refId: 'child-1', x: 500, y: 500, width: 1020, height: 780 },
    ]

    render(<TaskPanelContent panelId="panel-1" taskId="task-1" panelLayout="both" />)

    fireEvent.click(screen.getByText('Open child in window'))

    expect(bringToFrontMock).toHaveBeenCalledWith('panel-2')
    expect(addPanelMock).not.toHaveBeenCalled()
    expect(addEdgeMock).not.toHaveBeenCalled()
  })
})
