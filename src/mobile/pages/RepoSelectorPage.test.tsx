import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import type { Mock } from 'vitest'
import { RepoSelectorPage } from './RepoSelectorPage'
import { useTaskStore, type Task } from '../stores/task-store'
import { api } from '../api/client'

const mockNavigate = vi.fn()

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Task',
    description: '',
    type: 'general',
    priority: 'medium',
    status: 'not_started',
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
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

describe('RepoSelectorPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useTaskStore.setState({
      tasks: [makeTask()],
      isLoading: false
    })

    ;(api.github.getOrg as unknown as Mock).mockResolvedValue({ org: 'peakflo' })
    ;(api.github.getOrgs as unknown as Mock).mockResolvedValue([
      { value: 'peakflo', label: 'peakflo' },
      { value: 'other-org', label: 'other-org' }
    ])
    ;(api.github.fetchRepos as unknown as Mock).mockImplementation(async (org: string) => {
      if (org === 'other-org') {
        return [
          {
            name: 'other-repo',
            fullName: 'other-org/other-repo',
            defaultBranch: 'main',
            cloneUrl: 'https://github.com/other-org/other-repo.git',
            description: 'Other org repo',
            isPrivate: false
          }
        ]
      }
      return []
    })
  })

  it('allows changing org in header and reloads repos', async () => {
    const { container } = render(
      <RepoSelectorPage taskId="task-1" onNavigate={mockNavigate} />
    )

    await waitFor(() => {
      expect(api.github.fetchRepos).toHaveBeenCalledWith('peakflo')
    })

    const orgSelect = container.querySelector('select') as HTMLSelectElement
    fireEvent.change(orgSelect, { target: { value: 'other-org' } })

    await waitFor(() => {
      expect(api.github.setOrg).toHaveBeenCalledWith('other-org')
      expect(api.github.fetchRepos).toHaveBeenCalledWith('other-org')
    })
  })
})
