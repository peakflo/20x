import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskStatus, type WorkfloTask } from '@/types'
import { SubtasksTab } from './SubtasksTab'

afterEach(cleanup)

const subtasks = [
  { id: 'work', title: 'Build the view', status: TaskStatus.AgentWorking },
  { id: 'review', title: 'Check the view', status: TaskStatus.ReadyForReview },
  { id: 'done', title: 'Old work', status: TaskStatus.Completed },
  { id: 'todo', title: 'Plan the next step', status: TaskStatus.NotStarted }
] as WorkfloTask[]

describe('SubtasksTab', () => {
  it('filters by status and title, then opens the selected subtask', () => {
    const onNavigateToTask = vi.fn()
    render(<SubtasksTab subtasks={subtasks} onNavigateToTask={onNavigateToTask} />)
    expect(screen.getAllByRole('button', { name: /^Open subtask/ })).toHaveLength(4)

    fireEvent.click(screen.getByRole('button', { name: 'Ready for review' }))
    expect(screen.getAllByRole('button', { name: /^Open subtask/ })).toHaveLength(1)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search subtasks' }), { target: { value: 'missing' } })
    expect(screen.getByText('No subtasks match this search.')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search subtasks' }), { target: { value: 'CHECK' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open subtask Check the view' }))
    expect(onNavigateToTask).toHaveBeenCalledWith('review')

    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(within(screen.getByTestId('subtasks-tab-content')).getByText('1 of 4')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    expect(screen.getByText('No subtasks match this search.')).toBeInTheDocument()
  })

  it('opens a subtask beside its parent without navigating the current panel', () => {
    const onNavigateToTask = vi.fn()
    const onOpenSubtaskInWindow = vi.fn()
    const view = render(<SubtasksTab subtasks={subtasks} onNavigateToTask={onNavigateToTask} onOpenSubtaskInWindow={onOpenSubtaskInWindow} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open Check the view in a separate window' }))
    expect(onOpenSubtaskInWindow).toHaveBeenCalledExactlyOnceWith('review')
    expect(onNavigateToTask).not.toHaveBeenCalled()

    view.rerender(<SubtasksTab subtasks={subtasks} onNavigateToTask={onNavigateToTask} />)
    expect(screen.queryByRole('button', { name: 'Open Check the view in a separate window' })).not.toBeInTheDocument()
  })
})
