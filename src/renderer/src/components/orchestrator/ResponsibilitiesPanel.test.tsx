import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResponsibilitiesPanel } from './ResponsibilitiesPanel'
import type { ResponsibilitiesApi, ResponsibilityRecord, ResponsibilitySnapshot } from '@shared/responsibilities'

vi.mock('@/stores/task-store', () => ({ useTaskStore: { getState: () => ({ fetchTasks: vi.fn(async () => {}) }) } }))
vi.mock('@/lib/ui-remote-control', () => ({ applyUiCommand: vi.fn() }))

vi.mock('@/lib/ipc-client', () => ({
  settingsApi: { get: vi.fn(async () => 'project'), set: vi.fn(async () => {}) },
  agentApi: { getAll: vi.fn(async () => [{ id: 'agent', name: 'Engineer' }]) }
}))

let snapshot: ResponsibilitySnapshot
let api: ResponsibilitiesApi
const agreement: ResponsibilityRecord = {
  id: 'work', projectId: 'project', revision: 3, approvedRevision: null, humanInputId: 'human', state: 'proposed', steps: 0,
  noProgress: 0, nextAt: null, cursor: null, workspace: null, trial: null, next: null, createdAt: '2026-01-01', updatedAt: '2026-01-01',
  agreement: { kind: 'routine', title: 'Release watch', objective: 'Watch new failures', scope: 'This project', finish: 'Report actionable changes', stop: 'Before merge', mode: 'read', agentId: 'agent', priority: 'high', maxSteps: 8, deadline: '2030-01-01', schedule: '* * * * *', source: { command: 'gh', args: ['api', 'repos/example/project'], description: 'Read the release status' } }
}
beforeEach(() => {
  cleanup()
  snapshot = { projects: [{ id: 'project', name: 'Example project', root: '/example', agentId: 'agent', createdAt: '2026-01-01' }], responsibilities: [structuredClone(agreement)], notices: [], memory: [], steps: [] }
  api = {
    snapshot: vi.fn(async () => structuredClone(snapshot)), pickProjectFolder: vi.fn(async () => null), createProject: vi.fn(), act: vi.fn(async () => {}), answer: vi.fn(async () => {}), decideFactory: vi.fn(async () => {}), remember: vi.fn(async () => {}), forget: vi.fn(async () => {}), onChanged: vi.fn(() => () => {})
  }
  window.electronAPI.responsibilities = api
})

describe('project responsibility controls', () => {
  it('fills the selected folder, preserves it on cancellation, and creates only on explicit submit', async () => {
    render(<ResponsibilitiesPanel onProjectChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add engineering project' }))
    await screen.findByRole('option', { name: 'Engineer' })
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Peakflo' } })
    const field = screen.getByLabelText('Project folder')
    fireEvent.change(field, { target: { value: '~/old-folder' } })
    vi.mocked(api.pickProjectFolder).mockResolvedValueOnce('/Users/example/Project with spaces')
    fireEvent.click(screen.getByRole('button', { name: 'Select folder' }))
    await waitFor(() => expect(field).toHaveValue('/Users/example/Project with spaces'))
    expect(api.createProject).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Select folder' }))
    await waitFor(() => expect(api.pickProjectFolder).toHaveBeenCalledTimes(2))
    expect(field).toHaveValue('/Users/example/Project with spaces')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create project' })).not.toBeDisabled())
    vi.mocked(api.createProject).mockImplementationOnce(async (name, root, agentId) => {
      const created = { id: 'new-project', name, root, agentId, createdAt: '2026-01-01' }
      snapshot.projects.push(created)
      return created
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith('Peakflo', '/Users/example/Project with spaces', 'agent'))
    await waitFor(() => expect(screen.getByLabelText('Engineering project')).toHaveValue('new-project'))
  })

  it('requires a source trial before approval and sends the exact agreement revision', async () => {
    const selectProject = vi.fn()
    render(<ResponsibilitiesPanel onProjectChange={selectProject} />)
    await waitFor(() => expect(selectProject).toHaveBeenLastCalledWith(snapshot.projects[0]))
    fireEvent.click(screen.getByRole('button', { name: 'Show responsibilities' }))
    expect(screen.getByRole('button', { name: 'Approve and activate' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Run source trial' }))
    await waitFor(() => expect(api.act).toHaveBeenCalledWith('work', 3, 'trial'))
    expect(screen.getByText('Read the release status')).toBeInTheDocument()
  })

  it('keeps distinct pending questions visible and addresses the selected one', async () => {
    snapshot.notices = ['first', 'second'].map(id => ({ id, projectId: 'project', responsibilityId: 'work', stepId: id, kind: 'question', title: id, body: `Question ${id}`, state: 'pending', answer: null, recipient: null, createdAt: '2026-01-01' }))
    render(<ResponsibilitiesPanel onProjectChange={vi.fn()} />)
    fireEvent.click(await screen.findByText('2 decisions need you'))
    expect(screen.getByText('Question first')).toBeInTheDocument()
    expect(screen.getByText('Question second')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Answer second'), { target: { value: 'Keep the existing behavior' } })
    fireEvent.submit(screen.getByLabelText('Answer second').closest('form')!)
    await waitFor(() => expect(api.answer).toHaveBeenCalledWith('second', 'Keep the existing behavior', false))
  })

  it('shows provenance and edits memory without changing permissions', async () => {
    snapshot.memory = [{ id: 'memory', projectId: 'project', kind: 'preference', text: 'Keep updates concise', provenance: 'Engineer correction', updatedAt: '2026-01-01' }]
    render(<ResponsibilitiesPanel onProjectChange={vi.fn()} />)
    await screen.findByText('1 agreement to review')
    fireEvent.click(screen.getByRole('button', { name: 'Show responsibilities' }))
    fireEvent.click(screen.getByRole('tab', { name: 'memory' }))
    expect(screen.getByText('Engineer correction')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Remembered information'), { target: { value: 'Interrupt me for blockers' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }))
    await waitFor(() => expect(api.remember).toHaveBeenCalledWith('project', 'preference', 'Interrupt me for blockers', 'memory'))
    expect(api.act).not.toHaveBeenCalled()
  })
})
