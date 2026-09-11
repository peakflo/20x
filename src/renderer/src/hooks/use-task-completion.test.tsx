import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { useTaskCompletion } from './use-task-completion'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'
import { onShortcutFeedback } from '@/lib/keyboard-shortcuts'

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

describe('server completion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.electronAPI.db.manageScheduleTask = vi.fn(async () => ({ success: true }))
    window.electronAPI.taskSources.upload = vi.fn()
    storeState.tasks = []
  })
  afterEach(cleanup)

  it.each([
    { source_id: null, status: TaskStatus.AgentWorking, session_id: 'live-session' },
    { source_id: null, status: TaskStatus.ReadyForReview, session_id: 'saved-session' },
    { source_id: 'src-1', status: TaskStatus.ReadyForReview, session_id: null }
  ])('uses task administration for $status with source $source_id', async state => {
    storeState.tasks = [makeTask({ ...state, complete_at_source: false })]
    render(<Harness />); fireEvent.click(screen.getByText('Complete'))
    await waitFor(() => expect(onCompleted).toHaveBeenCalled())
    expect(window.electronAPI.db.manageScheduleTask).toHaveBeenCalledExactlyOnceWith('task-1', 'complete')
    expect(window.electronAPI.taskSources.upload).not.toHaveBeenCalled()
    expect(executeActionMock).not.toHaveBeenCalled()
    expect(updateTaskMock).not.toHaveBeenCalled()
  })

  it.each(['Task creation is pending in Workflo.', 'Review required', 'Runtime release failed'])('keeps an unconfirmed completion open: %s', async error => {
    vi.mocked(window.electronAPI.db.manageScheduleTask).mockResolvedValue({ success: false, error })
    storeState.tasks = [makeTask()]
    render(<Harness />); fireEvent.click(screen.getByText('Complete'))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith(error, true))
    expect(updateTaskMock).not.toHaveBeenCalled()
    expect(onCompleted).not.toHaveBeenCalled()
  })

  it('leaves a declined confirmation untouched without showing an error', async () => {
    vi.mocked(window.electronAPI.db.manageScheduleTask).mockResolvedValue({ success: false, cancelled: true })
    storeState.tasks = [makeTask()]
    render(<Harness />); fireEvent.click(screen.getByText('Complete'))
    await waitFor(() => expect(window.electronAPI.db.manageScheduleTask).toHaveBeenCalled())
    expect(onToast).not.toHaveBeenCalled()
    expect(onCompleted).not.toHaveBeenCalled()
    expect(updateTaskMock).not.toHaveBeenCalled()
  })

  it('reports failures to the shared app feedback when a canvas caller has no toast callback', async () => {
    const feedback = vi.fn(), off = onShortcutFeedback(feedback)
    function CanvasHarness() {
      const { requestComplete } = useTaskCompletion()
      return <button onClick={() => void requestComplete('task-1')}>Complete</button>
    }
    try {
      vi.mocked(window.electronAPI.db.manageScheduleTask).mockRejectedValue(new Error('Could not stop the local session'))
      storeState.tasks = [makeTask()]
      render(<CanvasHarness />); fireEvent.click(screen.getByText('Complete'))
      await waitFor(() => expect(feedback).toHaveBeenCalledWith({ message: 'Could not stop the local session', isError: true }))
    } finally { off() }
  })
})
