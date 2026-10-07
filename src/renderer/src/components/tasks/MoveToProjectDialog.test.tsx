import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MoveToProjectDialog } from './MoveToProjectDialog'
import { useProjectStore } from '@/stores/project-store'
import type { WorkfloProject } from '@/types'

function makeProject(overrides: Partial<WorkfloProject> = {}): WorkfloProject {
  return {
    id: 'proj-1',
    name: 'Website Redesign',
    description: '',
    color: '#6366f1',
    is_archived: false,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides
  }
}

afterEach(() => {
  cleanup()
  useProjectStore.setState({ projects: [], taskCounts: {}, isLoading: false, error: null })
})

describe('MoveToProjectDialog', () => {
  it('lists existing projects plus Inbox, and calls onMove with the chosen project id', () => {
    useProjectStore.setState({ projects: [makeProject()] })
    const onMove = vi.fn()

    render(
      <MoveToProjectDialog
        open
        onOpenChange={vi.fn()}
        currentProjectId={null}
        onMove={onMove}
      />
    )

    expect(screen.getByText('Inbox (no project)')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Website Redesign'))

    expect(onMove).toHaveBeenCalledWith('proj-1')
  })

  it('calls onMove(null) when Inbox is chosen', () => {
    useProjectStore.setState({ projects: [makeProject()] })
    const onMove = vi.fn()

    render(
      <MoveToProjectDialog
        open
        onOpenChange={vi.fn()}
        currentProjectId="proj-1"
        onMove={onMove}
      />
    )

    fireEvent.click(screen.getByText('Inbox (no project)'))
    expect(onMove).toHaveBeenCalledWith(null)
  })

  it('shows a hint when there are no projects yet', () => {
    useProjectStore.setState({ projects: [] })

    render(
      <MoveToProjectDialog
        open
        onOpenChange={vi.fn()}
        currentProjectId={null}
        onMove={vi.fn()}
      />
    )

    expect(screen.getByText(/No projects yet/)).toBeInTheDocument()
  })
})
