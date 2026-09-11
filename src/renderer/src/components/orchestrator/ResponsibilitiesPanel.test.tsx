import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { applyUiCommand } from '@/lib/ui-remote-control'
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

  it('labels queued work and opens the earlier blocking task', async () => {
    snapshot.responsibilities[0].state = 'active'
    snapshot.responsibilities[0].waitingFor = { responsibilityId: 'old', title: 'Interrupted investigation', taskId: 'old-task', needsAttention: true }
    vi.mocked(applyUiCommand).mockReturnValue({ applied: true } as ReturnType<typeof applyUiCommand>)
    render(<ResponsibilitiesPanel onProjectChange={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Engineering project')).toHaveValue('project'))
    fireEvent.click(screen.getByRole('button', { name: 'Show responsibilities' }))
    expect(screen.getByText('Queued')).toBeInTheDocument()
    expect(screen.getByText(/Waiting for “Interrupted investigation”/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Review blocking task' }))
    await waitFor(() => expect(applyUiCommand).toHaveBeenCalledWith({ kind: 'open_task', taskId: 'old-task', where: 'modal' }))
    expect(api.act).not.toHaveBeenCalled()
  })

  it('requires a source trial before approval and sends the exact agreement revision', async () => {
    const selectProject = vi.fn()
    snapshot.responsibilities[0].agreement.summary = 'Watch for release failures.'
    render(<ResponsibilitiesPanel onProjectChange={selectProject} />)
    await waitFor(() => expect(selectProject).toHaveBeenLastCalledWith(snapshot.projects[0]))
    fireEvent.click(screen.getByRole('button', { name: 'Show responsibilities' }))
    expect(screen.getByText('Watch new failures').closest('details')).toHaveAttribute('open')
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

  it('shows a short Work summary while preserving the complete request in its agreement', async () => {
    const record = snapshot.responsibilities[0]
    record.state = 'cancelled'
    record.agreement.summary = 'Check the release and stored data until the fix is verified.'
    record.agreement.objective = 'The full original request with its exact scope and constraints. '.repeat(12).trim()
    render(<ResponsibilitiesPanel onProjectChange={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Engineering project')).toHaveValue('project'))
    fireEvent.click(screen.getByRole('button', { name: 'Show responsibilities' }))
    expect(screen.getByText(record.agreement.summary)).toBeInTheDocument()
    const original = screen.getByText(record.agreement.objective)
    expect(original.closest('details')).not.toHaveAttribute('open')
    expect(screen.getByText('Full request')).toBeInTheDocument()
    expect(api.act).not.toHaveBeenCalled()
  })

  it('formats short decision questions and preserves the exact answer recipient', async () => {
    snapshot.notices = [{ id: 'question', projectId: 'project', responsibilityId: 'work', stepId: 'step', kind: 'question', title: 'Verify the release', body: 'Question: Which database should I check?\nWhy: Two connections are configured.\nReply: Production or staging.', state: 'pending', answer: null, recipient: null, createdAt: '2026-01-01' }]
    render(<ResponsibilitiesPanel onProjectChange={vi.fn()} />)
    fireEvent.click(await screen.findByText('1 decision need you'))
    expect(screen.getByText('Which database should I check?')).toBeInTheDocument()
    expect(screen.getByText('Two connections are configured.')).toBeInTheDocument()
    expect(screen.getByText('Production or staging.')).toBeInTheDocument()
    expect(screen.getByText('Task context')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Answer Verify the release'), { target: { value: 'Staging' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    await waitFor(() => expect(api.answer).toHaveBeenCalledWith('question', 'Staging', false))
  })

  it('collapses older long questions and reveals their original wording on demand', async () => {
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(180)
    try {
      const body = 'Original request with detailed context and internal identifiers. '.repeat(12).trim()
      snapshot.notices = [{ id: 'legacy', projectId: 'project', responsibilityId: 'work', stepId: 'step', kind: 'question', title: 'Previous monitoring request', body, state: 'pending', answer: null, recipient: null, createdAt: '2026-01-01' }]
      render(<ResponsibilitiesPanel onProjectChange={vi.fn()} />)
      fireEvent.click(await screen.findByText('1 decision need you'))
      const article = screen.getByLabelText('Answer Previous monitoring request').closest('article')!
      const content = within(article).getByText(body).closest('div.overflow-hidden') as HTMLElement
      expect(content.style.maxHeight).toBe('60px')
      fireEvent.click(within(article).getAllByRole('button', { name: 'Show more' }).at(-1)!)
      expect(content.style.maxHeight).toBe('')
      expect(within(article).getByText(body)).toBeInTheDocument()
      expect(api.answer).not.toHaveBeenCalled()
    } finally { height.mockRestore() }
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

it('shows captured access and verified-stop behavior, and sends permission approval without requiring text', async () => {
  snapshot.responsibilities[0].agreement.access = { permissionMode: 'allow', sandboxMode: 'danger-full-access' }
  snapshot.responsibilities[0].agreement.stopOnSuccess = true
  const permission = 'Allow this exact source access with its original permission details? '.repeat(12).trim()
  snapshot.notices = [{ id: 'permission', projectId: 'project', responsibilityId: 'work', stepId: 'step', kind: 'permission', title: 'Read source', body: permission, state: 'pending', answer: null, recipient: { sessionId: 'session', requestId: '0', responseType: 'permission' }, createdAt: '2026-01-01' }]
  render(<ResponsibilitiesPanel onProjectChange={vi.fn()} />)
  fireEvent.click(await screen.findByText('1 decision need you'))
  expect(screen.getByText(permission).closest('div.overflow-hidden')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Approve this request' }))
  await waitFor(() => expect(api.answer).toHaveBeenCalledWith('permission', 'Approved', true))
  fireEvent.click(screen.getByRole('tab', { name: 'work' }))
  expect(screen.getByText(/Full access — read-only work is an instruction/)).toBeInTheDocument()
  expect(screen.getByText(/Stop scheduling once the success evidence/)).toBeInTheDocument()
})
