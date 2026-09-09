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
  const getState = () => ({ tasks: storeState.tasks, updateTask: updateTaskMock, fetchTasks: async()=>undefined })
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

function completeLocallyMock() {
  return window.electronAPI.tasks.completeLocally as unknown as ReturnType<typeof vi.fn>
}

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

const notionSource = { id: 'src-notion', name: 'Notion', plugin_id: 'notion' }
const workfloSource = { id: 'src-wf', name: 'Workflo', plugin_id: 'peakflo' }

describe('useTaskCompletion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    executeActionMock.mockResolvedValue({ success: true })
    completeLocallyMock().mockResolvedValue({})
    storeState.tasks = []
    storeState.sources = [notionSource, workfloSource]
  })
  afterEach(cleanup)

  describe('source-less 20x task', () => {
    it('completes locally without asking or uploading', async () => {
      const upload = vi.fn()
      window.electronAPI.taskSources.upload = upload
      storeState.tasks = [makeTask()]
      render(<Harness />)
      fireEvent.click(screen.getByText('Complete'))

      await waitFor(() => expect(onCompleted).toHaveBeenCalled())
      expect(updateTaskMock).toHaveBeenCalledWith('task-1', { status: TaskStatus.Completed })
      expect(upload).not.toHaveBeenCalled()
      expect(executeActionMock).not.toHaveBeenCalled()
      expect(completeLocallyMock()).not.toHaveBeenCalled()
      expect(screen.queryByTestId('complete-at-source-dialog')).toBeNull()
    })
  })

  describe('Workflo task', () => {
    it.each([
      ['source plugin peakflo', makeTask({ source_id: 'src-wf' })],
      ['server_managed flag', makeTask({ source_id: 'src-other', server_managed: true })]
    ])('completes through the server action with no dialog (%s)', async (_label, task) => {
      storeState.tasks = [task]
      render(<Harness />)
      fireEvent.click(screen.getByText('Complete'))

      await waitFor(() => expect(onCompleted).toHaveBeenCalled())
      expect(executeActionMock).toHaveBeenCalledWith(PluginActionId.Complete, 'task-1', task.source_id)
      expect(screen.queryByTestId('complete-at-source-dialog')).toBeNull()
      expect(completeLocallyMock()).not.toHaveBeenCalled()
      // Workflo tasks never record a completion choice.
      expect(updateTaskMock).not.toHaveBeenCalled()
    })

    it('keeps a refused completion open', async () => {
      executeActionMock.mockResolvedValue({ success: false, error: 'Review required' })
      storeState.tasks = [makeTask({ source_id: 'src-wf' })]
      render(<Harness />)
      fireEvent.click(screen.getByText('Complete'))

      await waitFor(() => expect(onToast).toHaveBeenCalledWith('Review required', true))
      expect(updateTaskMock).not.toHaveBeenCalled()
      expect(onCompleted).not.toHaveBeenCalled()
    })
  })

  describe('Notion-style sourced task', () => {
    it('asks before doing anything', async () => {
      storeState.tasks = [makeTask({ source_id: 'src-notion' })]
      render(<Harness />)
      fireEvent.click(screen.getByText('Complete'))

      expect(await screen.findByTestId('complete-at-source-dialog')).toBeTruthy()
      expect(screen.getByText('Complete in Notion?')).toBeTruthy()
      expect(screen.getByTestId('complete-at-source')).toHaveTextContent('Update Notion too')
      expect(screen.getByTestId('complete-manually')).toHaveTextContent('Only in 20x')
      expect(executeActionMock).not.toHaveBeenCalled()
      expect(updateTaskMock).not.toHaveBeenCalled()
      expect(completeLocallyMock()).not.toHaveBeenCalled()
    })

    it('"Only in 20x" goes through task:completeLocally and never touches the source', async () => {
      storeState.tasks = [makeTask({ source_id: 'src-notion' })]
      render(<Harness />)
      fireEvent.click(screen.getByText('Complete'))
      fireEvent.click(await screen.findByTestId('complete-manually'))

      await waitFor(() => expect(completeLocallyMock()).toHaveBeenCalledWith('task-1'))
      expect(executeActionMock).not.toHaveBeenCalled()
      // No renderer status write: the guard lives in the main process.
      expect(updateTaskMock).not.toHaveBeenCalled()
      expect(onCompleted).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1', status: TaskStatus.Completed }))
      expect(onToast).toHaveBeenCalledWith('"Fix the login bug" completed in 20x only')
      await waitFor(() => expect(screen.queryByTestId('complete-at-source-dialog')).toBeNull())
    })

    it('"Update Notion too" runs the source action, then records the choice without a status', async () => {
      storeState.tasks = [makeTask({ source_id: 'src-notion' })]
      render(<Harness />)
      fireEvent.click(screen.getByText('Complete'))
      fireEvent.click(await screen.findByTestId('complete-at-source'))

      await waitFor(() => expect(executeActionMock).toHaveBeenCalledWith(PluginActionId.Complete, 'task-1', 'src-notion'))
      await waitFor(() => expect(updateTaskMock).toHaveBeenCalledWith('task-1', { complete_at_source: true }))
      expect(updateTaskMock).not.toHaveBeenCalledWith('task-1', expect.objectContaining({ status: TaskStatus.Completed }))
      expect(completeLocallyMock()).not.toHaveBeenCalled()
      expect(onToast).toHaveBeenCalledWith('"Fix the login bug" completed')
      await waitFor(() => expect(screen.queryByTestId('complete-at-source-dialog')).toBeNull())
    })

    it('uses the action output field as the source action id', async () => {
      storeState.tasks = [makeTask({
        source_id: 'src-notion',
        output_fields: [{ id: 'action', value: PluginActionId.Approve }] as WorkfloTask['output_fields']
      })]
      render(<Harness />)
      fireEvent.click(screen.getByText('Complete'))
      fireEvent.click(await screen.findByTestId('complete-at-source'))

      await waitFor(() => expect(executeActionMock).toHaveBeenCalledWith(PluginActionId.Approve, 'task-1', 'src-notion'))
    })

    it('keeps the dialog open and reports the error when the source refuses', async () => {
      executeActionMock.mockResolvedValue({ success: false, error: 'Notion rejected the update' })
      storeState.tasks = [makeTask({ source_id: 'src-notion' })]
      render(<Harness />)
      fireEvent.click(screen.getByText('Complete'))
      fireEvent.click(await screen.findByTestId('complete-at-source'))

      await waitFor(() => expect(onToast).toHaveBeenCalledWith('Notion rejected the update', true))
      expect(updateTaskMock).not.toHaveBeenCalled()
      expect(onCompleted).not.toHaveBeenCalled()
      expect(screen.getByTestId('complete-at-source-dialog')).toBeTruthy()
    })

    it('keeps the dialog open when the main process refuses "Only in 20x"', async () => {
      completeLocallyMock().mockRejectedValue(new Error('Workflo controls task status.'))
      storeState.tasks = [makeTask({ source_id: 'src-notion' })]
      render(<Harness />)
      fireEvent.click(screen.getByText('Complete'))
      fireEvent.click(await screen.findByTestId('complete-manually'))

      await waitFor(() => expect(onToast).toHaveBeenCalledWith('Workflo controls task status.', true))
      expect(onCompleted).not.toHaveBeenCalled()
      expect(screen.getByTestId('complete-at-source-dialog')).toBeTruthy()
    })

    it('completes nothing when the user cancels', async () => {
      storeState.tasks = [makeTask({ source_id: 'src-notion' })]
      render(<Harness />)
      fireEvent.click(screen.getByText('Complete'))
      fireEvent.click(await screen.findByText('Cancel'))

      await waitFor(() => expect(screen.queryByTestId('complete-at-source-dialog')).toBeNull())
      expect(executeActionMock).not.toHaveBeenCalled()
      expect(updateTaskMock).not.toHaveBeenCalled()
      expect(completeLocallyMock()).not.toHaveBeenCalled()
    })

    it('honours a stored "Only in 20x" answer without asking', async () => {
      storeState.tasks = [makeTask({ source_id: 'src-notion', complete_at_source: false })]
      render(<Harness />)
      fireEvent.click(screen.getByText('Complete'))

      await waitFor(() => expect(completeLocallyMock()).toHaveBeenCalledWith('task-1'))
      expect(screen.queryByTestId('complete-at-source-dialog')).toBeNull()
      expect(executeActionMock).not.toHaveBeenCalled()
    })

    it('honours a stored "update the source too" answer without asking', async () => {
      storeState.tasks = [makeTask({ source_id: 'src-notion', complete_at_source: true })]
      render(<Harness />)
      fireEvent.click(screen.getByText('Complete'))

      await waitFor(() => expect(executeActionMock).toHaveBeenCalledWith(PluginActionId.Complete, 'task-1', 'src-notion'))
      expect(screen.queryByTestId('complete-at-source-dialog')).toBeNull()
      expect(completeLocallyMock()).not.toHaveBeenCalled()
    })

    it('falls back to the task source label when the source record is not loaded', async () => {
      storeState.sources = []
      storeState.tasks = [makeTask({ source_id: 'src-linear', source: 'linear' })]
      render(<Harness />)
      fireEvent.click(screen.getByText('Complete'))

      expect(await screen.findByText('Complete in linear?')).toBeTruthy()
    })
  })
})
