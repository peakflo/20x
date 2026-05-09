import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TaskPanelContent } from './TaskPanelContent'

const { updatePanelMock, selectTaskMock, updateTaskMock, taskList } = vi.hoisted(() => ({
  updatePanelMock: vi.fn(),
  selectTaskMock: vi.fn(),
  updateTaskMock: vi.fn(),
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
  TaskWorkspace: ({ onNavigateToTask }: { onNavigateToTask?: (taskId: string) => void }) => (
    <button type="button" onClick={() => onNavigateToTask?.('child-1')}>
      Navigate to child
    </button>
  ),
}))

vi.mock('@/stores/canvas-store', () => ({
  useCanvasStore: (selector: (state: { updatePanel: typeof updatePanelMock }) => unknown) =>
    selector({ updatePanel: updatePanelMock }),
}))

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
  beforeEach(() => {
    vi.clearAllMocks()
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
})
