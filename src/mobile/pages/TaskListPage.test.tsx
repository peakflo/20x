import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { api } from '../api/client'
import { useTaskStore, type Task } from '../stores/task-store'
import { TaskListPage } from './TaskListPage'

const task = (id: string, status: string): Task => ({
  id, title: id, description: '', status, priority: 'medium', parent_task_id: null,
  snoozed_until: null, is_recurring: false, recurrence_parent_id: null,
  created_at: '2026-01-01T00:00:00.000Z', sort_order: 0
}) as Task

beforeEach(() => {
  vi.clearAllMocks()
  useTaskStore.setState({
    tasks: [task('Open task', 'not_started')], isLoading: false,
    completedTotal: 2, completedLoaded: 0, completedLoading: false
  })
})

afterEach(cleanup)

describe('TaskListPage completed history', () => {
  it('downloads closed tasks when opened, then loads the next page', async () => {
    vi.mocked(api.tasks.completedPage)
      .mockResolvedValueOnce({ tasks: [task('Old task', 'completed')], total: 2 })
      .mockResolvedValueOnce({ tasks: [task('Older task', 'completed')], total: 2 })

    render(<TaskListPage onNavigate={vi.fn()} />)
    expect(screen.getByText('Closed (2)')).toBeDefined()
    expect(screen.queryByText('Old task')).toBeNull()

    fireEvent.click(screen.getByText('Closed (2)'))
    await waitFor(() => expect(screen.getByText('Old task')).toBeDefined())
    expect(api.tasks.completedPage).toHaveBeenCalledWith({ offset: 0, limit: 50 })

    fireEvent.click(screen.getByText('Show more'))
    await waitFor(() => expect(screen.getByText('Older task')).toBeDefined())
    expect(api.tasks.completedPage).toHaveBeenLastCalledWith({ offset: 1, limit: 50 })
    expect(screen.queryByText('Show more')).toBeNull()
  })
})
