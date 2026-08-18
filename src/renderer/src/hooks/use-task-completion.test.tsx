import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { useTaskCompletion } from './use-task-completion'
import { TaskStatus, PluginActionId } from '@/types'
import type { WorkfloTask } from '@/types'

const { updateTaskMock, executeActionMock, storeState } = vi.hoisted(() => ({
  updateTaskMock: vi.fn(async () => undefined),
  executeActionMock: vi.fn<() => Promise<{ success: boolean; error?: string }>>(async () => ({
    success: true
  })),
  storeState: {
    tasks: [] as unknown[],
    sources: [] as unknown[]
  }
}))

vi.mock('@/stores/task-store', () => {
  const getState = () => ({ tasks: storeState.tasks, updateTask: updateTaskMock })
  const useTaskStore = (selector: (s: ReturnType<typeof getState>) => unknown) => selector(getState())
  useTaskStore.getState = getState
  return { useTaskStore }
})

vi.mock('@/stores/task-source-store', () => {
  const getState = () => ({ sources: storeState.sources, executeAction: executeActionMock })
  const useTaskSourceStore = (selector: (s: ReturnType<typeof getState>) => unknown) =>
    selector(getState())
  useTaskSourceStore.getState = getState
  return { useTaskSourceStore }
})

function makeTask(overrides: Partial<WorkfloTask> = {}): WorkfloTask {
  return {
    id: 'task-1',
    title: 'Fix the login bug',
    description: '',
    type: 'general',
    priority: 'medium',
    status: TaskStatus.ReadyForReview,
    assignee: '',
    due_date: null,
    labels: [],
    attachments: [],
    repos: [],
    output_fields: [],
    agent_id: null,
    session_id: null,
    external_id: null,
    source_id: null,
    source: 'manual',
    skill_ids: null,
    snoozed_until: null,
    resolution: null,
    feedback_rating: null,
    feedback_comment: null,
    is_recurring: false,
    recurrence_pattern: null,
    recurrence_parent_id: null,
    last_occurrence_at: null,
    next_occurrence_at: null,
    auto_start_agent: false,
    auto_complete_without_review: false,
    complete_at_source: null,
    parent_task_id: null,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides
  } as WorkfloTask
}

const onToast = vi.fn()
const onCompleted = vi.fn()

function Harness({ taskId = 'task-1' }: { taskId?: string }) {
  const { requestComplete, completionDialog } = useTaskCompletion({ onToast })
  return (
    <>
      <button type="button" onClick={() => void requestComplete(taskId, { onCompleted })}>
        Complete
      </button>
      {completionDialog}
    </>
  )
}

describe('useTaskCompletion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    executeActionMock.mockResolvedValue({ success: true })
    storeState.tasks = []
    storeState.sources = []
  })

  afterEach(cleanup)

  it('completes a task with no source immediately, without asking', async () => {
    storeState.tasks = [makeTask({ source_id: null })]
    render(<Harness />)

    fireEvent.click(screen.getByText('Complete'))

    await waitFor(() =>
      expect(updateTaskMock).toHaveBeenCalledWith('task-1', { status: TaskStatus.Completed })
    )
    expect(executeActionMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('complete-at-source-dialog')).toBeNull()
    expect(onCompleted).toHaveBeenCalled()
  })

  it('asks before completing a task that came from a source', async () => {
    storeState.tasks = [makeTask({ source_id: 'src-1' })]
    storeState.sources = [{ id: 'src-1', name: 'Linear' }]
    render(<Harness />)

    fireEvent.click(screen.getByText('Complete'))

    expect(await screen.findByTestId('complete-at-source-dialog')).toBeTruthy()
    // Nothing happens until the user answers.
    expect(executeActionMock).not.toHaveBeenCalled()
    expect(updateTaskMock).not.toHaveBeenCalled()
    expect(screen.getByText('Complete in Linear?')).toBeTruthy()
  })

  it('pushes the completion to the source when the user picks "complete at source"', async () => {
    storeState.tasks = [makeTask({ source_id: 'src-1' })]
    storeState.sources = [{ id: 'src-1', name: 'Linear' }]
    render(<Harness />)

    fireEvent.click(screen.getByText('Complete'))
    fireEvent.click(await screen.findByTestId('complete-at-source'))

    await waitFor(() =>
      expect(executeActionMock).toHaveBeenCalledWith(PluginActionId.Complete, 'task-1', 'src-1')
    )
    expect(updateTaskMock).toHaveBeenCalledWith('task-1', {
      status: TaskStatus.Completed,
      complete_at_source: true
    })
    await waitFor(() => expect(screen.queryByTestId('complete-at-source-dialog')).toBeNull())
  })

  it('skips the source call when the user picks "I\'ll do it manually"', async () => {
    storeState.tasks = [makeTask({ source_id: 'src-1' })]
    storeState.sources = [{ id: 'src-1', name: 'Linear' }]
    render(<Harness />)

    fireEvent.click(screen.getByText('Complete'))
    fireEvent.click(await screen.findByTestId('complete-manually'))

    await waitFor(() =>
      expect(updateTaskMock).toHaveBeenCalledWith('task-1', {
        status: TaskStatus.Completed,
        complete_at_source: false
      })
    )
    expect(executeActionMock).not.toHaveBeenCalled()
    expect(onToast).toHaveBeenCalledWith('"Fix the login bug" completed in 20x only')
  })

  it('uses the action output field as the source action id', async () => {
    storeState.tasks = [
      makeTask({
        source_id: 'src-1',
        output_fields: [{ id: 'action', value: PluginActionId.Approve }] as WorkfloTask['output_fields']
      })
    ]
    storeState.sources = [{ id: 'src-1', name: 'Peakflo' }]
    render(<Harness />)

    fireEvent.click(screen.getByText('Complete'))
    fireEvent.click(await screen.findByTestId('complete-at-source'))

    await waitFor(() =>
      expect(executeActionMock).toHaveBeenCalledWith(PluginActionId.Approve, 'task-1', 'src-1')
    )
  })

  it('keeps the task open and reports the error when the source call fails', async () => {
    storeState.tasks = [makeTask({ source_id: 'src-1' })]
    storeState.sources = [{ id: 'src-1', name: 'Linear' }]
    executeActionMock.mockResolvedValue({ success: false, error: 'Linear rejected the update' })
    render(<Harness />)

    fireEvent.click(screen.getByText('Complete'))
    fireEvent.click(await screen.findByTestId('complete-at-source'))

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith('Linear rejected the update', true)
    )
    expect(updateTaskMock).not.toHaveBeenCalled()
    // The dialog stays open so the user can retry or complete manually.
    expect(screen.getByTestId('complete-at-source-dialog')).toBeTruthy()
  })

  it('completes nothing when the user cancels', async () => {
    storeState.tasks = [makeTask({ source_id: 'src-1' })]
    storeState.sources = [{ id: 'src-1', name: 'Linear' }]
    render(<Harness />)

    fireEvent.click(screen.getByText('Complete'))
    fireEvent.click(await screen.findByText('Cancel'))

    await waitFor(() => expect(screen.queryByTestId('complete-at-source-dialog')).toBeNull())
    expect(executeActionMock).not.toHaveBeenCalled()
    expect(updateTaskMock).not.toHaveBeenCalled()
  })

  it('does not ask again when the feedback dialog already recorded the answer', async () => {
    storeState.tasks = [makeTask({ source_id: 'src-1', complete_at_source: false })]
    storeState.sources = [{ id: 'src-1', name: 'Notion' }]
    render(<Harness />)

    fireEvent.click(screen.getByText('Complete'))

    await waitFor(() =>
      expect(updateTaskMock).toHaveBeenCalledWith('task-1', {
        status: TaskStatus.Completed,
        complete_at_source: false
      })
    )
    expect(screen.queryByTestId('complete-at-source-dialog')).toBeNull()
    expect(executeActionMock).not.toHaveBeenCalled()
  })

  it('honours a recorded "close it at the source" answer without asking', async () => {
    storeState.tasks = [makeTask({ source_id: 'src-1', complete_at_source: true })]
    storeState.sources = [{ id: 'src-1', name: 'Notion' }]
    render(<Harness />)

    fireEvent.click(screen.getByText('Complete'))

    await waitFor(() =>
      expect(executeActionMock).toHaveBeenCalledWith(PluginActionId.Complete, 'task-1', 'src-1')
    )
    expect(updateTaskMock).toHaveBeenCalledWith('task-1', {
      status: TaskStatus.Completed,
      complete_at_source: true
    })
    expect(screen.queryByTestId('complete-at-source-dialog')).toBeNull()
  })

  it('falls back to the task source label when the source record is not loaded', async () => {
    storeState.tasks = [makeTask({ source_id: 'src-1', source: 'jira' })]
    storeState.sources = []
    render(<Harness />)

    fireEvent.click(screen.getByText('Complete'))

    expect(await screen.findByText('Complete in jira?')).toBeTruthy()
  })
})
