import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'
import { TaskHeaderBar, TaskPrimaryAction } from '../TaskHeaderBar'
import { makeRemote } from './test-fixtures'

const task = { id: 'task-1', title: 'A very long task title '.repeat(10), status: TaskStatus.ReadyForReview, priority: 'medium', output_fields: [], labels: [] } as unknown as WorkfloTask
const props = { onRename: vi.fn(), detailsOpen: false, showDetailsToggle: false, onToggleDetails: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }
afterEach(cleanup)

describe('TaskHeaderBar for remote tasks', () => {
  it('shows runner chip, sync badge, Open in Spaces and no local Complete', () => {
    render(<TaskHeaderBar {...props} task={task} remote={makeRemote()} action={TaskPrimaryAction.COMPLETE} onComplete={vi.fn()} />)
    expect(screen.getByTestId('runner-chip').textContent).toContain('studio-mac')
    expect(screen.getByTestId('sync-badge').textContent).toContain('Synced')
    expect(screen.getByText('Open in Spaces')).toBeTruthy()
    expect(screen.queryByTestId('header-cta-complete')).toBeNull()
  })

  it('keeps Complete for local tasks', () => {
    render(<TaskHeaderBar {...props} task={task} onComplete={vi.fn()} />)
    expect(screen.getByTestId('header-cta-complete')).toBeTruthy()
  })
})
