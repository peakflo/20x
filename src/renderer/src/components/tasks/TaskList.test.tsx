import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'
import { TaskList } from './TaskList'

function makeTask(i: number, status: TaskStatus = TaskStatus.NotStarted): WorkfloTask {
  return {
    id: `t${i}`,
    title: `Task ${i}`,
    status,
    created_at: new Date(1_750_000_000_000 + i).toISOString(),
    updated_at: new Date(1_750_000_000_000 + i).toISOString(),
    labels: [],
    attachments: [],
    repos: [],
    output_fields: []
  } as unknown as WorkfloTask
}

afterEach(cleanup)

describe('TaskList', () => {
  it('renders every open task and selects on click', () => {
    const onSelect = vi.fn()
    render(<TaskList tasks={Array.from({ length: 10 }, (_, i) => makeTask(i))} selectedTaskId={null} onSelectTask={onSelect} />)
    expect(screen.getAllByText(/^Task \d+$/)).toHaveLength(10)
    fireEvent.click(screen.getByText('Task 3'))
    expect(onSelect).toHaveBeenCalledWith('t3')
  })

  it('shows the database completed total and loads the first page on open', () => {
    const onLoadMore = vi.fn()
    render(
      <TaskList
        tasks={[makeTask(1)]}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        completedTotal={1200}
        hasMoreCompleted
        onLoadMoreCompleted={onLoadMore}
      />
    )
    expect(screen.getByText('1200')).toBeTruthy()
    fireEvent.click(screen.getByText('Closed'))
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('renders only loaded completed tasks with a Show more button', () => {
    const onLoadMore = vi.fn()
    const completed = Array.from({ length: 3 }, (_, i) => makeTask(100 + i, TaskStatus.Completed))
    render(
      <TaskList
        tasks={[makeTask(1), ...completed]}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        completedTotal={1200}
        hasMoreCompleted
        onLoadMoreCompleted={onLoadMore}
      />
    )
    fireEvent.click(screen.getByText('Closed'))
    // Less than one page loaded: opening fetches the next page.
    expect(onLoadMore).toHaveBeenCalledTimes(1)
    expect(screen.getAllByText(/^Task 10\d$/)).toHaveLength(3)
    fireEvent.click(screen.getByText('Show more'))
    expect(onLoadMore).toHaveBeenCalledTimes(2)
  })

  it('hides Show more when all completed tasks are loaded', () => {
    render(
      <TaskList
        tasks={[makeTask(1), makeTask(2, TaskStatus.Completed)]}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        completedTotal={1}
        hasMoreCompleted={false}
      />
    )
    fireEvent.click(screen.getByText('Closed'))
    expect(screen.queryByText('Show more')).toBeNull()
  })

  it('shows cancelled and expired tasks in closed history with their status', () => {
    render(<TaskList tasks={[makeTask(1, TaskStatus.Cancelled), makeTask(2, TaskStatus.Expired)]} selectedTaskId={null} onSelectTask={vi.fn()} />)
    fireEvent.click(screen.getByText('Closed'))
    expect(screen.getByText('Cancelled')).toBeTruthy()
    expect(screen.getByText('Expired')).toBeTruthy()
  })
})
