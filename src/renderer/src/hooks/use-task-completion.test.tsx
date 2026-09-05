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
  beforeEach(() => { vi.clearAllMocks(); executeActionMock.mockResolvedValue({success:true}); storeState.tasks=[] })
  afterEach(cleanup)
  it('always calls the source and never writes local completion', async () => {
    storeState.tasks=[makeTask({source_id:'src-1',complete_at_source:false})]
    render(<Harness />); fireEvent.click(screen.getByText('Complete'))
    await waitFor(()=>expect(onCompleted).toHaveBeenCalled())
    expect(executeActionMock).toHaveBeenCalledWith(PluginActionId.Complete,'task-1','src-1')
    expect(updateTaskMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('requires a server task before completion',async()=>{
    storeState.tasks=[makeTask()];render(<Harness />);fireEvent.click(screen.getByText('Complete'))
    await waitFor(()=>expect(onToast).toHaveBeenCalledWith(expect.stringContaining('Send this task'),true))
    expect(updateTaskMock).not.toHaveBeenCalled();expect(executeActionMock).not.toHaveBeenCalled();expect(onCompleted).not.toHaveBeenCalled()
  })
  it('keeps a refused completion open',async()=>{
    executeActionMock.mockResolvedValue({success:false,error:'Review required'})
    storeState.tasks=[makeTask({source_id:'src-1'})];render(<Harness />);fireEvent.click(screen.getByText('Complete'))
    await waitFor(()=>expect(onToast).toHaveBeenCalledWith('Review required',true))
    expect(updateTaskMock).not.toHaveBeenCalled();expect(onCompleted).not.toHaveBeenCalled()
  })
})
