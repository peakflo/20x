import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { applyUiCommand } from '@/lib/ui-remote-control'
import { ResponsibilitiesPanel } from './ResponsibilitiesPanel'
import { useUIStore } from '@/stores/ui-store'
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
  vi.clearAllMocks()
  useUIStore.setState({ mastermindDraft: null, mastermindProjectToOpen: null, mastermindProjectId: '', mastermindProjects: [], mastermindTaskProjects: {}, mastermindSnapshotLoaded: false, mastermindSelectionHydrated: false })
  snapshot = { projects: [{ id: 'project', name: 'Example project', root: '/example', agentId: 'agent', createdAt: '2026-01-01' }], responsibilities: [structuredClone(agreement)], notices: [], memory: [], steps: [] }
  api = {
    setProactive: vi.fn(async () => {}), retryFollowups: vi.fn(async () => {}), snapshot: vi.fn(async () => structuredClone(snapshot)), pickProjectFolder: vi.fn(async () => null), createProject: vi.fn(), act: vi.fn(async () => {}), answer: vi.fn(async () => {}), decideFactory: vi.fn(async () => {}), remember: vi.fn(async () => {}), forget: vi.fn(async () => {}), onChanged: vi.fn(() => () => {})
  }
  window.electronAPI.responsibilities = api
})

describe('project responsibility controls', () => {
  it('opens and focuses the exact blocked agreement from a notice without a step', async () => {
    const originalScroll = HTMLElement.prototype.scrollIntoView
    const scroll = vi.fn()
    HTMLElement.prototype.scrollIntoView = scroll
    try {
      snapshot.responsibilities[0].state = 'blocked'
      snapshot.responsibilities.unshift({ ...structuredClone(agreement), id: 'other', state: 'blocked', agreement: { ...agreement.agreement, title: 'Other work' } })
      snapshot.notices = [{ id: 'limits', projectId: 'project', responsibilityId: 'work', stepId: null, kind: 'recovery', title: 'Release watch', body: 'The agreed time, step, or no-progress limit was reached.', state: 'pending', answer: null, recipient: null, createdAt: '2026-01-02' }]
      render(<ResponsibilitiesPanel onProjectChange={vi.fn()} />)
      fireEvent.click(await screen.findByText('1 decision need you'))
      expect(screen.queryByRole('button', { name: 'Open task' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Ask Mastermind' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Review work' }))
      expect(screen.getByRole('tab', { name: 'work' })).toHaveAttribute('aria-selected', 'true')
      const target = screen.getByText('Release watch').closest('article')!
      expect(within(target).getByText('Agreement and evidence').closest('details')).toHaveAttribute('open')
      expect(screen.getByText('Other work').closest('article')!.querySelector('details')).not.toHaveAttribute('open')
      expect(document.activeElement).toBe(target.parentElement)
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest' })
      expect(api.act).not.toHaveBeenCalled()
      expect(api.answer).not.toHaveBeenCalled()
    } finally { HTMLElement.prototype.scrollIntoView = originalScroll }
  })

  it.each([null, 'coordinate'])('opens saved worker context for a recovery notice linked to %s', async stepId => {
    snapshot.responsibilities[0].state = 'blocked'
    snapshot.steps = [
      { id: 'old', responsibilityId: 'work', taskId: 'old-task', phase: 'work', createdAt: '2026-01-01' },
      { id: 'worker', responsibilityId: 'work', taskId: 'correct-task', phase: 'work', createdAt: '2026-01-02' },
      { id: 'coordinate', responsibilityId: 'work', taskId: 'coordinator-task', phase: 'coordinate', createdAt: '2026-01-03' },
      { id: 'unrelated', responsibilityId: 'other', taskId: 'unrelated-task', phase: 'work', createdAt: '2026-01-03' },
      { id: 'future', responsibilityId: 'work', taskId: 'later-task', phase: 'work', createdAt: '2026-01-05' }
    ] as ResponsibilitySnapshot['steps']
    snapshot.notices = [{ id: 'limits', projectId: 'project', responsibilityId: 'work', stepId, kind: 'recovery', title: 'Release watch', body: 'Review saved work.', state: 'pending', answer: null, recipient: null, createdAt: '2026-01-04' }]
    vi.mocked(applyUiCommand).mockReturnValue({ applied: true } as ReturnType<typeof applyUiCommand>)
    render(<ResponsibilitiesPanel onProjectChange={vi.fn()} />)
    fireEvent.click(await screen.findByText('1 decision need you'))
    fireEvent.click(screen.getByRole('button', { name: 'Open task' }))
    await waitFor(() => expect(applyUiCommand).toHaveBeenCalledWith({ kind: 'open_task', taskId: 'correct-task', where: 'modal' }))
    expect(api.act).not.toHaveBeenCalled()
  })

  it.each(['pending', 'expired'] as const)('offers a scoped editable Mastermind follow-up for %s recovery even without saved work', async state => {
    snapshot.responsibilities = []
    snapshot.notices = [{ id: 'orphan-notice', projectId: 'project', responsibilityId: null, stepId: null, kind: 'recovery', title: 'Score results', body: 'Review progress.', state, answer: null, recipient: null, createdAt: '2026-01-04' }]
    render(<ResponsibilitiesPanel onProjectChange={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Engineering project')).toHaveValue('project'))
    fireEvent.click(screen.getByRole('button', { name: 'Show responsibilities' }))
    fireEvent.click(screen.getByRole('tab', { name: 'decisions' }))
    expect(screen.queryByRole('button', { name: 'Review work' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open task' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ask Mastermind' }))
    expect(useUIStore.getState().mastermindDraft).toMatchObject({ projectId: 'project', text: expect.stringContaining('Follow-up: orphan-notice') })
    expect(useUIStore.getState().mastermindDraft?.text).toContain('for my approval before restarting')
    expect(api.act).not.toHaveBeenCalled()
    expect(api.answer).not.toHaveBeenCalled()
  })

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

  it('opens the saved task without takeover controls', async () => {
    snapshot.responsibilities[0].state = 'active'
    snapshot.steps = [{ id: 'step', responsibilityId: 'work', taskId: 'saved-task', phase: 'work', state: 'running' } as ResponsibilitySnapshot['steps'][number]]
    vi.mocked(applyUiCommand).mockReturnValue({ applied: true } as ReturnType<typeof applyUiCommand>)
    render(<ResponsibilitiesPanel onProjectChange={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Engineering project')).toHaveValue('project'))
    fireEvent.click(screen.getByRole('button', { name: 'Show responsibilities' }))
    expect(screen.queryByRole('button', { name: /take ?over|hand back/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open work · running' }))
    await waitFor(() => expect(applyUiCommand).toHaveBeenCalledWith({ kind: 'open_task', taskId: 'saved-task', where: 'modal' }))
    expect(api.act).not.toHaveBeenCalled()
  })

  it('pauses and continues proactive follow-up while the project details are collapsed', async () => {
    snapshot.followups = { project: { enabled: true, reviewing: false, pending: 1, error: 'Delivery needs review.' } }
    vi.mocked(api.setProactive).mockImplementation(async (id, enabled) => { snapshot.followups![id].enabled = enabled })
    render(<ResponsibilitiesPanel onProjectChange={vi.fn()} />)
    const control = await screen.findByRole('button', { name: 'Pause proactive follow-up' })
    expect(screen.getByRole('button', { name: 'Show responsibilities' })).toBeInTheDocument()
    fireEvent.click(control)
    expect(control).toBeDisabled()
    await waitFor(() => expect(api.setProactive).toHaveBeenCalledWith('project', false))
    const resume = await screen.findByRole('button', { name: 'Continue proactive follow-up' })
    await waitFor(() => expect(resume).not.toBeDisabled())
    expect(screen.getByRole('status')).toHaveTextContent('Proactive follow-up · Paused')
    fireEvent.click(resume)
    await waitFor(() => expect(api.setProactive).toHaveBeenLastCalledWith('project', true))
    await screen.findByRole('button', { name: 'Pause proactive follow-up' })
    expect(screen.getByRole('status')).toHaveTextContent('Proactive follow-up · On')
    fireEvent.click(screen.getByRole('button', { name: 'Retry follow-up' }))
    await waitFor(() => expect(api.retryFollowups).toHaveBeenCalledWith('project'))
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

it('moves obsolete questions to collapsed history, removes broken task links and refreshes on a stale reply error', async () => {
  snapshot.responsibilities[0].state = 'blocked'
  snapshot.steps = [{ id: 'step', responsibilityId: 'work', taskId: 'deleted-task', phase: 'work', state: 'settled', taskAvailable: true, createdAt: '2026-01-01' }] as ResponsibilitySnapshot['steps']
  snapshot.notices = [{ id: 'question', projectId: 'project', responsibilityId: 'work', stepId: 'step', kind: 'question', title: 'Choose the environment', body: 'Staging or production?', state: 'pending', answer: null, recipient: null, createdAt: '2026-01-02' }]
  vi.mocked(api.answer).mockImplementation(async () => {
    snapshot.steps[0].taskAvailable = false
    Object.assign(snapshot.notices[0], { state: 'superseded', resolutionReason: 'No longer needed — task deleted', resolvedAt: '2026-01-03T10:00:00Z' })
    throw new Error('The work changed. Refresh to see the current work.')
  })
  render(<ResponsibilitiesPanel onProjectChange={vi.fn()} />)
  fireEvent.click(await screen.findByText('1 decision need you'))
  fireEvent.change(screen.getByRole('textbox', { name: 'Answer Choose the environment' }), { target: { value: 'Staging' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('The work changed')
  const history = await screen.findByText('History (1)')
  expect(history.closest('details')).not.toHaveAttribute('open')
  expect(screen.queryByText('1 decision need you')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Send answer' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Open task' })).not.toBeInTheDocument()
  fireEvent.click(history)
  expect(screen.getByText('No longer needed — task deleted')).toBeInTheDocument()
  expect(history.closest('details')!.querySelector('time')).toHaveAttribute('dateTime', '2026-01-03T10:00:00Z')
  fireEvent.click(screen.getByRole('tab', { name: 'work' }))
  expect(screen.getByText('Task deleted · work')).toBeInTheDocument()
})

it('keeps uncertain delivery visible and actionable above answered history', async () => {
  const notice = { projectId: 'project', responsibilityId: 'work', stepId: null, kind: 'question' as const, title: 'Choose the environment', body: 'Staging or production?', answer: 'Staging', recipient: null, createdAt: '2026-01-02' }
  snapshot.notices = [{ ...notice, id: 'uncertain', state: 'expired', deliveryError: 'The recipient did not confirm delivery' }, { ...notice, id: 'answered', state: 'answered', resolvedAt: '2026-01-03', resolutionReason: 'Answer accepted' }]
  render(<ResponsibilitiesPanel onProjectChange={vi.fn()} />)
  fireEvent.click(await screen.findByText('1 decision need you'))
  expect(screen.getByRole('alert')).toHaveTextContent('did not confirm delivery')
  expect(screen.getByRole('button', { name: 'Ask Mastermind' })).toBeInTheDocument()
  expect(screen.getByText('History (1)').closest('details')).not.toHaveAttribute('open')
  expect(api.answer).not.toHaveBeenCalled()
})
